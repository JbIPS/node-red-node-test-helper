/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/
'use strict';

const path = require("path");
const sinon = require("sinon");
const should = require('should');
require('should-sinon');
const when = require("when");
const request = require('supertest');
const express = require("express");
const http = require('http');
const stoppable = require('stoppable');
const readPkgUp = require('read-pkg-up');
const EventEmitter = require('events').EventEmitter;

const PROXY_METHODS = ['log', 'status', 'warn', 'error', 'debug', 'trace', 'send'];

/**
 * Finds the NR runtime path by inspecting environment
 */
function findRuntimePath() {
    const upPkg = readPkgUp.sync();
    // case 1: we're in NR itself
    if (upPkg.pkg.name === 'node-red') {
        return path.join(path.dirname(upPkg.path), upPkg.pkg.main);
    }
    // case 2: NR is installed alongside node-red-node-test-helper
    if ((upPkg.pkg.dependencies && upPkg.pkg.dependencies['node-red'])
        || (upPkg.pkg.devDependencies && upPkg.pkg.devDependencies['node-red'])) {
        const dirpath = path.join(path.dirname(upPkg.path), 'node_modules', 'node-red');
    try {
            const pkg = require(path.join(dirpath, 'package.json'));
            return path.join(dirpath, pkg.main);
        } catch (ignored) {}
    }
}

class NodeTestHelper extends EventEmitter {
    constructor() {
        super();

        this._sandbox = sinon.createSandbox();

        this._address = '127.0.0.1';
        this._listenPort = 0; // ephemeral

        this.init();
    }

    _initRuntime(requirePath) {
        try {
            const RED = this._RED = require(requirePath);

            // public runtime API
            this._redNodes = RED.nodes;
            this._events = RED.events;
            this._log = RED.log;

            // access internal Node-RED runtime methods
            const prefix = path.dirname(requirePath);
            this._context = require(path.join(prefix, 'runtime', 'nodes', 'context'));
            this._comms = require(path.join(prefix, 'api', 'editor', 'comms'));

            this.credentials = require(path.join(prefix, 'runtime', 'nodes', 'credentials'));

            // proxy the methods on Node.prototype to both be Sinon spies and asynchronously emit
            // information about the latest call
            const NodePrototype = require(path.join(prefix, 'runtime', 'nodes', 'Node')).prototype;
            PROXY_METHODS.forEach(methodName => {
                const spy = this._sandbox.spy(NodePrototype, methodName);
                NodePrototype[methodName] = new Proxy(spy, {
                    apply: (target, thisArg, args) => {
                        const retval = Reflect.apply(target, thisArg, args);
                        process.nextTick(function(call) { return () => {
                            NodePrototype.emit.call(thisArg, `call:${methodName}`, call);
                        }}(spy.lastCall));
                        return retval;
                    }
                });
            });
        } catch (ignored) {
            // ignore, assume init will be called again by a test script supplying the runtime path
        }
    }

    init(runtimePath = findRuntimePath()) {
        if (runtimePath) {
            this._initRuntime(runtimePath);
        }
    }

    load(testNode, testFlow, testCredentials, cb) {
        const log = this._log;
        const logSpy = this._logSpy = this._sandbox.spy(log, 'log');
        logSpy.FATAL = log.FATAL;
        logSpy.ERROR = log.ERROR;
        logSpy.WARN = log.WARN;
        logSpy.INFO = log.INFO;
        logSpy.DEBUG = log.DEBUG;
        logSpy.TRACE = log.TRACE;
        logSpy.METRIC = log.METRIC;
        this.log = () => logSpy;

        if (typeof testCredentials === 'function') {
            cb = testCredentials;
            testCredentials = {};
        }

        var storage = {
            getFlows: function() {
                return when.resolve({flows:testFlow,credentials:testCredentials});
            }
        };

        var settings = {
            available: function() { return false; }
        };

        var red = {
            _: v => v
        };

        Object.keys(this._RED).filter(prop => !/^(init|start|stop)$/.test(prop))
        .forEach(prop => {
            const propDescriptor = Object.getOwnPropertyDescriptor(this._RED, prop);
            Object.defineProperty(red, prop, propDescriptor);
        });

        const redNodes = this._redNodes;
        redNodes.init({
            events: this._events,
            settings: settings,
            storage:storage,
            log:this._log
        });
        redNodes.registerType("helper", function (n) {
            redNodes.createNode(this, n);
        });

        if (Array.isArray(testNode)) {
            testNode.forEach(fn => {
                fn(red);
            });
        } else {
            testNode(red);
        }

        redNodes.loadFlows()
            .then(() => {
                redNodes.startFlows();
                should.deepEqual(testFlow, redNodes.getFlows().flows);
                cb();
            });
    }

    unload() {
        // TODO: any other state to remove between tests?
        this._redNodes.clearRegistry();
        this._logSpy.restore();
        this._sandbox.reset();

        // internal API
        this._context.clean({allNodes:[]});
        return this._redNodes.stopFlows();
    }

    /**
     * Returns a Node by id.
     * @param {string} id - Node ID
     * @returns {Node}
     */
    getNode(id) {
        return this._redNodes.getNode(id);
    }

    clearFlows() {
        return this._redNodes.stopFlows();
    }

    request() {
        return request(this._RED.httpAdmin);
    }

    startServer(done) {
        this._app = express();
        const server = stoppable(http.createServer((req,res) => {
            this._app(req,res);
        }), 0);

        this._RED.init(server, {
            SKIP_BUILD_CHECK: true,
            logging:{console:{level:'off'}}
        });
        server.listen(this._listenPort, this._address);
        server.on('listening', () => {
            this._port = server.address().port;
            this.url = `http://${this._address}:${this._port}`;
            // internal API
            this._comms.start();
            done();
        });
        this._server = server;
    }

    //TODO consider saving TCP handshake/server reinit on start/stop/start sequences
    stopServer(done) {
        if (this._server) {
            try {
                // internal API
                this._comms.stop();
                this._server.stop(done);
            } catch(e) {
                done();
            }
        } else {
            done();
        }
    }
}

module.exports = new NodeTestHelper();
module.exports.NodeTestHelper = NodeTestHelper;
