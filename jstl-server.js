(function (publicApi) {
	var util = require('util');
	var http = require('http');
	var fs = require('fs');
	var path = require('path');
	var querystring = require('querystring');
	
	var ent = require('ent');
	var mime = require('mime');
	var jstl = require('jstl');
	
	var JSON_MEDIA_TYPE = /^application\/([a-zA-Z+]\+)?json(;.*)?/;
	
	function DocumentShard(executeFunction, defaultToDone) {
		if (!executeFunction) {
			throw new Error;
		}
		
		var thisShard = this;
		var queue = [];
		var bufferString = "";
		var callbacks = null;
		
		this.echo = function (string) {
			if (queue.length == 0 && callbacks) {
				callbacks.data(string);
			} else {
				bufferString += string;
			}
		};
		function resultIsError(error) {
			queue = [];
			if (callbacks && callbacks.finished) {
				callbacks.finished(error);
			} else {
				thisShard.callbacks = function (dc, fc) {
					process.nextTick(function () {
						fc(error);
					});
					return this;
				};
			}
			callbacks.data = callbacks.finished = function () {};
		}
		function shardComplete(error) {
			if (error) {
				resultIsError(error);
				callbacks = null;
				return;
			}
			queue.shift();
			moveToNextShard();
		}
		function moveToNextShard() {
			while (queue.length > 0) {
				if (queue[0] instanceof DocumentShard) {
					queue[0].callbacks(callbacks.data, shardComplete);
					return;
				} else {
					callbacks.data(queue.shift());
				}
			}
			if (bufferString) {
				callbacks.data(bufferString);
				bufferString = "";
			}
			if (executed && callbacks.finished) {
				callbacks.finished();
			}
		}
		this.callbacks = function (dc, fc) {
			callbacks = {
				data: dc,
				finished: fc
			};
			moveToNextShard();
			return this;
		};
		
		this.shard = function (executeFunction) {
			if (bufferString || (queue.length == 0 && !callbacks)) {
				queue.push(bufferString);
				bufferString = "";
			}

			var shard = new DocumentShard(executeFunction);
			queue.push(shard);
			if (queue.length == 0) {
				if (callbacks) {
					shard.callbacks(callbacks.data, shardComplete);
				} else {
					shard.callbacks(function (data) {
						queue[0] += data;
					});
				}
			}
			return this;
		};
		
		var executed = false;
		var doneCallback = function (error) {
			if (error) {
				resultIsError(error);
			}
			executed = true;
			if (callbacks) {
				moveToNextShard();
			}
		};
		this.wait = function () {
			defaultToDone = false;
		};
		this.shard.echo = this.echo;
		this.shard.done = doneCallback;
		this.shard.wait = this.wait;
		process.nextTick(function () {
			var result = executeFunction.call(thisShard, thisShard.shard, thisShard.echo);
			if (result instanceof Error) {
				resultIsError(result);
				return;
			}
			if (result || defaultToDone) {
				if (typeof result == "string") {
					thisShard.echo(result);
				}
				doneCallback();
			}
			if (callbacks) {
				moveToNextShard();
			}
		});
	}
	
	function modelToFilter(model) {
		if (typeof model == "boolean") {
			return function () {
				return model ? {} : false;
			};
		} else if (typeof model == "string") {
			return function (request, response) {
				if (request.path.substring(0, model.length) == model) {
					return {};
				}
				return false;
			};
		} else if (model instanceof RegExp) {
			return function (request, response) {
				return model.exec(request.path);
			}
		}
		return model;
	}
	
	function Handler(model, execFunction) {
		var filter = modelToFilter(model);
		
		this.process = function (request, response, next) {
			var params;
			if (!(params = filter(request, response))) {
				return next();
			}
			request.params = params;
			return execFunction.call(this, request, response, next);
		}
	}
	Handler.prototype = {
		writeShard: function writeShard(request, response, execFunction) {
			var shard = new DocumentShard(execFunction, true);
			shard.callbacks(function (data) {
				response.write(data.toString(), 'utf8');
			}, function (error) {
				if (error) {
					publicApi.errorPage(500, error, request, response);
					return;
				}
				response.end();
			});
		}
	};
	
	function CompositeHandler() {
		CompositeHandler.super_.apply(this, arguments);
		
		var handlers = [];
		this.addHandler = function (handler) {
			handlers.push(handler);
			return this;
		};
		this.subHandlers = function (request, response, next) {
			var index = 0;
			function tryNextHandler() {
				if (index < handlers.length) {
					var handler = handlers[index++];
					return handler.process(request, response, tryNextHandler);
				}
				next();
			}
			tryNextHandler();
		};
	}
	util.inherits(CompositeHandler, Handler);
	
	var JSON_MEDIA_TYPE = /^application\/([a-zA-Z0-9+]+)?json(;.*)$/g;
	
	function JstlServer() {
		JstlServer.super_.call(this);
		
		var handlers = [];
		this.addHandler = function handler(handler) {
			handlers.push(handler);
			return this;
		}
		
		this.on('request', function (request, response) {
			var handlerIndex = 0;
			
			function tryNextHandler() {
				if (handlerIndex < handlers.length) {
					var handler = handlers[handlerIndex++];
					return handler.process(request, response, tryNextHandler);
				}
				publicApi.errorPage(404, null, request, response);
			}
			return tryNextHandler();
		});
	}
	util.inherits(JstlServer, http.Server);
	
	publicApi.errorPage = function errorPage(code, error, request, response) {
		if (!response.headersSent) {	
			response.statusCode = code;
			response.setHeader('Content-Type', 'application/json');
		}
		var trace = null;
		if (error) {
			trace =error.stack.split("\n");
		}
		response.end("\n\n" + JSON.stringify({
			statusCode: code,
			statusText: http.STATUS_CODES[code],
			error: util.inspect(error),
			trace: trace
		}, null, '\t'));
	};
	
	publicApi.DocumentShard = DocumentShard;
	publicApi.Handler = Handler;
	publicApi.CompositeHandler = CompositeHandler;
	publicApi.createServer = function () {
		var server = new JstlServer();
		server.addHandler(enhanceRequests);
		return server;
	};
	
	var enhanceRequests = new Handler(/.*/, function (request, response, next) {
		request.localPath = ".";
		
		var queryIndex = request.url.indexOf("?");
		if (queryIndex >= 0) {
			request.path = request.url.substring(0, queryIndex);
			request.queryString = request.url.substring(queryIndex + 1);
			request.query = querystring.parse(request.queryString);
		} else {
			request.path = request.url;
			request.queryString = "";
			request.query = {};
		}
		request.params = {};
		
		request.getData = function (callback) {
			var data = null;
			var dataObj = undefined;
			request.on('data', function (dataPart) {
				data ? (data = dataPart) : (data += dataPart);
			});
			request.on('end', function () {
				var contentType = request.headers['content-type'];
				if (JSON_MEDIA_TYPE.test(contentType)) {
					try {
						dataObj = JSON.parse(data);
					} catch (e) {
					}
				} else if (contentType == "application/x-www-form-urlencoded") {
					dataObj = querystring.parse(data);
				}
				request.getData = function (callback) {
					callback(null, dataObj || data, data);
				};
				callback(null, dataObj || data, data);
			});
		};
		next();
	});
	
	publicApi.directoryHandler = function (webPath, localPath) {
		if (webPath.charAt(webPath.length - 1) != "/") {
			webPath += "/";
		}
		if (localPath.charAt(localPath.length - 1) != "/") {
			localPath += "/";
		}
		var filter = function (request, response) {
			return request.path.substring(0, webPath.length) == webPath;
		};
		
		return new CompositeHandler(filter, function (request, response, next) {
			var oldWebPath = request.path;
			var oldLocalPath = request.localPath;
			
			var remainder = request.path.substring(webPath.length - 1);
			remainder = path.normalize(remainder).replace(/^(\.\.\/)*/g, "");

			request.path = remainder;
			request.localPath = path.resolve(request.localPath, localPath);
			
			this.subHandlers(request, response, function () {
				request.path = oldWebPath;
				request.localPath = oldLocalPath;
				next();
			});
		});
	};
	
	publicApi.fileReader = function (model, fileHandler, indexFiles) {
		var filter = modelToFilter(model);
		
		return new Handler(filter, function (request, response, next) {
			var thisHandler = this;
			if (request.path.charAt(request.path.length - 1) == "/") {
				next();
			}
			var filePath = request.path;
			if (filePath.charAt(0) == "/") {
				filePath = filePath.substring(1);
			}
			filePath = path.resolve(request.localPath, filePath);
			fs.readFile(filePath, function (error, buffer) {
				if (error) {
					if (error.code == 'ENOENT' || error.code == 'ENOTDIR') {
						return next();
					}
					throw error;
				}
				return fileHandler.call(thisHandler, request, response, buffer, next);
			});
		});
	};
	
	publicApi.indexFiles = function (model, indexFiles) {
		var filter = modelToFilter(model);
		if (indexFiles == undefined) {
			indexFiles = [];
		}
		
		return new CompositeHandler(filter, function (request, response, next) {
			var thisHandler = this;
			var index = 0;
			var oldPath = request.path;
			function tryNextIndex() {
				request.path = oldPath;
				if (index >= indexFiles.length) {
					return next();
				}
				request.path += indexFiles[index++];
				thisHandler.subHandlers(request, response, tryNextIndex);
			}
			return tryNextIndex();
		});
	};
	
	var handlers = {};
	publicApi.handlers = handlers;
	
	handlers.plain = publicApi.indexFiles(true, ["index.html", "index.htm"])
		.addHandler(publicApi.fileReader(true, function (request, response, buffer, next) {
			var mimeType = mime.lookup(request.path);
			response.setHeader('Content-Type', mimeType);
			response.end(buffer);
		}));

	handlers.jstl = (function () {
		var jstlCache = {};
		var cacheMilliseconds = 10000;
		function deleteTimeout(path) {
			return setTimeout(function() {
				delete jstlCache[path];
			}, cacheMilliseconds);
		}
		function setCached(path, template) {
			var entry;
			if (entry = jstlCache[path]) {
				clearTimeout(entry.timeout);
				entry.timeout = deleteTimeout(path);
				return;
			}
			jstlCache[path] = {
				template: template,
				when: new Date,
				timeout: deleteTimeout(path)
			};
		}
		function getCached(path) {
			var entry = jstlCache[path];
			if (entry) {
				clearTimeout(entry.timeout);
				entry.timeout = deleteTimeout(path);
			}
			return entry;
		}
	
		var jstlReader = publicApi.indexFiles(true, ["index.jshtml"]);
		jstlReader.addHandler(new Handler(true, function (request, response, next) {
			var thisHandler = this;
			var scriptPath = request.localPath + request.path;
			var cached = getCached(scriptPath);
			if (!cached) {
				return next();
			}
			fs.stat(scriptPath, function (error, stats) {
				if (error) {
					return next();
				}
				if (stats.mtime >= cached.when) {
					return next();
				}
				var template = cached.template;

				response.setHeader('Content-Type', 'text/html');
				thisHandler.writeShard(request, response, function (shard, echo) {
					return template.call(this, request, response, shard, echo);
				});
			});
		}));
		jstlReader.addHandler(publicApi.fileReader(true, function (request, response, buffer, next) {
			var template = jstl.create(buffer.toString()).compile(function (varName) {
				if (varName.charAt(0) == "=") {
					return "ent.encode('' + (" + varName.substring(1) + "))";
				} else if (varName.charAt(0) == "%") {
					return "encodeURIComponents('' + (" + varName.substring(1) + "))";
				} else if (varName.charAt(0) == ":") {
					return "JSON.stringify('' + (" + varName.substring(1) + "))";
				} else if (varName.charAt(0) == "*") {
					return "('' + (" + varName.substring(1) + "))";
				}
			}, [
				"var request = arguments[0];",
				"var response = arguments[1];",
				"var shard = arguments[2];",
				"var echo = arguments[3];"
			].join("\n"),
			{
				ent: ent,
				require: require,
				echo: null
			});
		
			var scriptPath = request.localPath + request.path;
			setCached(scriptPath, template);
		
			response.setHeader('Content-Type', 'text/html');
			this.writeShard(request, response, function (shard, echo) {
				return template.call(this, request, response, shard, echo);
			});
		}));
		return jstlReader;
	})();
		
})(module.exports);