
// 转义html
// var escapeHtml = require('escape-html');
// 解析url模块
var path = require('path');
var fs = require('fs');
var log = require('../src/log');
var config = require('../src/config');
var querystring = require('querystring');
var Promise = require('promise');
var getProjectConfig = require('../src/getProjectConfig');
var URL = require('url');
var fileNotFoundErr = require('./tools').fileNotFoundErr;
var parsePath, parseOneGroup, parseBranch, parseOneBranch, redirectUrl, execParse, reduceExec, redirectOneUrl, contentOneUrl, headersOneUrl;

/**
 * 根据配置文件和当前路径解析出一个合理的文件路径，解析成功则返回文件路径
 *
 * @param {String} pathname
 * @return{String} path，返回一个绝对的文件路径，如果文件找到的话
 */
parsePath = function(url) {
	url = querystring.unescape(url);
	var pathTree = config.get();
	// 获取路径
	var host = pathTree.host;
	var funs =[];
	if (host && host.length) {
		for(var i = 0; i < host.length; i++) {
			funs.push({
				fun: parseOneGroup,
				param: [host[i], url]
			});
		}
		return execParse(funs).then(function(res) {
			if (!res) {
				return Promise.reject(fileNotFoundErr('没有找到可用的分支'));
			}
			return res;
		});
	} else {
		return Promise.reject(fileNotFoundErr('请至少配置一个可以用的分组'));
	}
};

parseOneGroup = function(oneGroup, url) {
	var branches, funs;
	// 如果禁用这个分组直接跳出
	if (oneGroup.disabled) {
		return Promise.resolve();
	}
	branches = oneGroup.branches;
	if (branches && branches.length) {
		funs = [];
		for (var k = 0; k < branches.length; k++) {
			funs.push({
				fun: parseBranch,
				param: [branches[k], url, oneGroup.groupName]
			});
		}
		return execParse(funs);
	} else {
		return Promise.resolve();
	}
};

parseBranch = function(branch, url, groupName) {
	var basePath;
	var	current;
	if (branch.disabled) {
		return Promise.resolve();
	}
	basePath = branch.basePath || "";
	var val = [];
	if (branch.val && branch.val.length && branch.val.slice) {
		val = branch.val.slice(0);
	}
	if (!val.length && !basePath) {
		return Promise.resolve();
	}
	// 判断当前用户是否已经添加了一个路径表示当前跟路径的路径,并且没有配置虚拟路径
	var status = val.some(function(current) {
		if (path.resolve(basePath, (current.codePath || '')) === basePath &&  !current.virtualPath) {
			return true;
		}
	});
	// 如果没有帮用户添加一个--添加到队列的前面
	if (!status) {
		val.push({
			codePath: './'
		});
	}
	var funs = [];
	for(var j = 0; j < val.length; j++) {
		// 获取项目单独的配置，这里可以配置路由重定向
		current = val[j];
		if (current.disabled) {
			continue;
		}
		funs.push({
			fun: parseOneBranch,
			param: [basePath, groupName, branch.branchName, current,  url]
		});
	}
	return execParse(funs);
};

parseOneBranch = function(basePath, groupName, branchName, current,  originalUrl) {
	var tmp, v, reg, p, codePath,
		changePathname,
		exists;
	return redirectUrl(originalUrl, groupName, branchName)
		.then(function(url) {
			var content, headers;
			// 直接由用户设置了内容
			if (url && url.url ) {
				if (url.content) {
					content = url.content;
				}
				if (url.headers) {
					headers = url.headers;
				}
				url = url.url;
			}
			changePathname = URL.parse(url).pathname;
			// 如果codePath为空默认为当前子路径
			codePath = current.codePath || "";
			// 将基础路径和 代码路径合并
			codePath = path.resolve(basePath, codePath);
			// 虚拟路径处理
			if (current.virtualPath) {
				v = path.normalize("/" + current.virtualPath);
				changePathname = path.normalize(changePathname);
				v = v.replace(/[\*\.\?\+\$\^\[\]\(\)\{\}\|\\\/]/g, function(cur) {
					return "\\" + cur;
				});
				tmp = ["^", v].join('');
				// 创建正则
				reg = new RegExp(tmp);
				// // 符合路经规则--去掉虚拟路径
				if (reg.test(changePathname)) {
					changePathname = changePathname.replace(reg, "");
					p = path.join(codePath, changePathname);
				}
			} else {
				p = path.join(codePath, changePathname);
			}

			if (content) {
				return {
					fullPath: '',
					// 用户设置的基础路径
					userBasePath: basePath,
					// 当前ftl文件的基础路径
					basePath: codePath,
					// ftl相对路径
					path: changePathname,
					groupName: groupName,
					branchName: branchName,
					originalUrl: originalUrl,
					url: url,
					content,
					headers
				};
			}
			if (p) {
				exists = fs.existsSync(p);
				if (exists) {
					return {
					// ftl全路径
						fullPath: p,
						// 用户设置的基础路径
						userBasePath: basePath,
						// 当前ftl文件的基础路径
						basePath: codePath,
						// ftl相对路径
						path: changePathname,
						groupName: groupName,
						branchName: branchName,
						originalUrl: originalUrl,
						url: url,
						headers
					};
				}
			}
		});
};

redirectUrl = function(url, groupName, branchName) {
	var type, reg, tmp, funs = [];
	var commandConfig = getProjectConfig(groupName, branchName);
	if (commandConfig && commandConfig.routes && commandConfig.routes.length) {
		for(var i = 0, l = commandConfig.routes.length; i < l; i++) {
			tmp = commandConfig.routes[i];
			if (tmp && tmp.test && (tmp.redirect || typeof tmp.content === 'function' || typeof tmp.headers === 'function')) {
				type = typeof tmp.test;
				if (type === "string") {
					reg = new RegExp(type);
				} else if(tmp.test instanceof RegExp){
					reg =  tmp.test;
				}
				if (reg && reg.test(url)) {
					if (tmp.headers) {
						funs.push({
							fun: headersOneUrl,
							param: [url, reg, tmp.headers]
						});
					} else if (tmp.redirect) {
						funs.push({
							fun: redirectOneUrl,
							param: [url, reg, tmp.redirect]
						});
					} else if (tmp.content){
						funs.push({
							fun: contentOneUrl,
							param: [url, reg, tmp.content]
						});
					}
				}
			}
		}
	}
	return reduceExec(funs)
		.then(function(res) {
			console.log(res, url);
			res = res || url;
			return res;
		})
		.catch(function(e) {
			console.error(e);
			return url;
		}); 
};
// 重定向其中一个url
redirectOneUrl = function(url, reg, redirect) {
	var nUrl, checkUrl = /^http.*/;
	if (typeof redirect === "string") {
		url = url.replace(reg, redirect);
		if (checkUrl.test(url)) {
			return {
				url
			};
		}
	} else if (redirect instanceof Function) {
		nUrl = redirect(url);
		// 返回的是一个string
		if (typeof nUrl === 'string') {
			if (checkUrl.test(nUrl)) {
				return {
					url: nUrl
				};
			}
		// 返回一个promise对象
		} else if (nUrl && nUrl.then){
			return nUrl.then(function(myUrl) {
				if (checkUrl.test(myUrl)) {
					return {
						url: nUrl
					};
				} else {
					return {
						url
					};
				}
			});
		}
	}
	return {
		url
	};

};

// 这里返回的可能不是一个url，而是一个object，如果是一个obj必须有 url字段和content字段
// 如： { 'aaa' , '/test'}
contentOneUrl = function (url, reg, content) {
	try {
		const res = content(url) || {};
		// promise直接返回，但是结果必须是带url和content的字段否则会被忽略
		if (res.then) {
			return res.then(function(result) {
				return result.content ?  Object.assign({ url: url }, result) : { url };
			});
		}
		return res.content ?  Object.assign({ url: url} , res) : { url };
	} catch (err) {
		log.error(err);
	}
	return {
		url
	};
};

headersOneUrl = function(url, reg, headers) {
	try {
		const res = headers(url) || {};
		// promise直接返回，但是结果必须是带url和content的字段否则会被忽略
		if (res.then) {
			return res.then(function(result) {
				return result.headers ?  Object.assign({ url: url }, result) : url;
			});
		}
		return res.headers ?  Object.assign({ url: url }, res) : url;
	} catch (err) {
		log.error(err);
	}
	return {
		url
	};
};
/**
 * 按tasks的顺序执行promise
 * 
 * @param  {[array]} tasks  [任务列表]
 * [{
 * 	fun: fun,
 * 	param: [param]
 * }]
 * @return {[promise]}        [promise]
 */
execParse = function(tasks, index) {
	if (!tasks || !tasks.length) {
		return Promise.resolve();
	}
	if (!index) {
		index = 0;
	}
	var current = tasks[index];
	var next = tasks[index + 1];
	var result = current.fun.apply(null, current.param);
	// 不是promise转换成promise
	if (!result || !result.then) {
		result = Promise.resolve(result);
	}
	return result.then(function(res) {
		if (res) {
			return res;
		}
		if (next) {
			return execParse(tasks, index + 1);
		} else {
			return '';
		}
	});
};

reduceExec = function (tasks) {
	if (!tasks || !tasks.length) {
		return Promise.resolve();
	}
	const pm = tasks.reduceRight(function (res, current) {
		let result = current.fun.apply(null, current.param);
		if (!result || !result.then) {
			result = Promise.resolve(result);
		}
		res.push(result);
		return res;
	}, []);
	return Promise.all(pm).then(function (res) {
		return res.reduce(function (r, current) {
			Object.assign(r, current);
			return r;
		}, {});
	});
};
// parsePath.execParse = execParse;
module.exports = parsePath;
