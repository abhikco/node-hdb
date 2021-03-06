// Copyright 2013 SAP AG.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http: //www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
// either express or implied. See the License for the specific
// language governing permissions and limitations under the License.
'use strict';
/*jshint expr:true*/

var lib = require('../lib');
var mock = require('./mock');
var util = lib.util;
var Connection = lib.Connection;
var MessageType = lib.common.MessageType;
var FunctionCode = lib.common.FunctionCode;
var SegmentKind = lib.common.SegmentKind;
var PartKind = lib.common.PartKind;

function connect(options, connectListener) {
  var socket = mock.createSocket(options);
  util.setImmediate(connectListener);
  return socket;
}

function createConnection(options) {
  var settings = {};
  var connection = new Connection(util.extend(settings, options));
  connection._connect = connect;
  connection._settings.should.equal(settings);
  (!!connection._socket).should.be.not.ok;
  return connection;
}

function getAuthenticationPart(req) {
  return req.parts.filter(function (part) {
    return part.kind === PartKind.AUTHENTICATION;
  }).shift().args;
}

function sendAuthenticationRequest(req, done) {
  var reply = {
    authentication: getAuthenticationPart(req)
  };
  if (reply.authentication instanceof Error) {
    return done(reply.authentication);
  }
  if (reply.authentication === 'FINAL') {
    reply.connectOptions = [];
  }
  done(null, reply);
}

describe('Lib', function () {

  describe('#Connection', function () {
    it('should create a connection without any options', function () {
      var connection = new Connection();
      connection._settings.should.eql({});
    });

    it('should create a connection', function () {
      var connection = createConnection();
      var state = connection._state;
      connection.setAutoCommit(true);
      connection.autoCommit = true;
      connection.autoCommit.should.be.true;
      connection.holdCursorsOverCommit = true;
      connection.holdCursorsOverCommit.should.be.true;
      connection.scrollableCursor = true;
      connection.scrollableCursor.should.be.true;
      connection.readyState.should.equal('new');
      connection._socket = {
        readyState: 'open'
      };
      connection.readyState.should.equal('opening');
      connection.protocolVersion = {
        major: 4,
        minor: 1
      };
      connection.readyState.should.equal('disconnected');
      state.messageType = MessageType.AUTHENTICATE;
      connection.readyState.should.equal('connecting');
      state.messageType = MessageType.CONNECT;
      connection.readyState.should.equal('connecting');
      state.messageType = MessageType.NIL;
      state.sessionId = 1;
      connection.readyState.should.equal('connected');
      state.messageType = MessageType.DISCONNECT;
      connection.readyState.should.equal('disconnecting');
      connection._socket.readyState = 'readOnly';
      connection.readyState.should.equal('closed');
      connection._state = undefined;
      connection.readyState.should.equal('closed');
    });

    it('should close an already closed Connection', function () {
      var connection = createConnection();
      connection._state = undefined;
      connection.close();
      connection.readyState.should.equal('closed');
    });

    it('should open and close a Connection', function (done) {
      var connection = createConnection();
      connection.open({}, function (err) {
        (!!err).should.be.not.ok;
        connection._socket.readyState.should.equal('open');
        connection.protocolVersion.should.eql({
          major: 4,
          minor: 1
        });
        connection.readyState.should.equal('disconnected');
        connection.close();
      });
      connection.on('close', function (hadError) {
        hadError.should.be.false;
        connection.readyState.should.equal('closed');
        done();
      });
      connection.readyState.should.equal('opening');
    });

    it('should fail to open a Connection with an invalid reply', function (done) {
      var connection = createConnection();
      connection.open({
        invalidInitializationReply: true
      }, function (err) {
        err.code.should.equal('EHDBINIT');
        done();
      });
    });

    it('should fail to open a Connection with a socket error', function (done) {
      var connection = createConnection();
      connection.open({
        initializationErrorCode: 'SOCKET_ERROR'
      }, function (err) {
        err.code.should.equal('SOCKET_ERROR');
        done();
      });
    });

    it('should destroy itself on transaction error', function (done) {
      var connection = createConnection();
      connection.open({}, function (err) {
        (!!err).should.be.not.ok;
        connection.readyState.should.equal('disconnected');
        connection._socket.end();
        connection.readyState.should.equal('closed');
        connection.setTransactionFlags({
          sessionClosingTransactionErrror: true
        });
        connection.readyState.should.equal('closed');
        done();
      });
    });

    it('should dispatch a socket error', function (done) {
      var connection = createConnection();
      var socketError = new Error('SOCKET_ERROR');
      connection.open({}, function (err) {
        (!!err).should.be.not.ok;
        connection._socket.emit('error', socketError);
      });
      connection.once('error', function (err) {
        err.should.equal(socketError);
        done();
      });
    });

    it('should get the available message buffer size', function () {
      var connection = createConnection();
      var maxAvailableSize = connection.getAvailableSize();
      connection._statementContext = {
        size: 32
      };
      connection.getAvailableSize().should.equal(maxAvailableSize - 32);
    });

    it('should parse a reply', function () {
      var connection = createConnection();
      var segment = new lib.reply.Segment();
      segment.kind = SegmentKind.REPLY;
      var reply = connection._parseReplySegment(segment.toBuffer(0));
      reply.kind.should.equal(SegmentKind.REPLY);
      reply.functionCode.should.equal(FunctionCode.NIL);
    });

    it('should receive different kind of replies', function () {
      var connection = createConnection();
      var replies = {
        errorSegment: {
          kind: SegmentKind.ERROR,
          error: new Error('ERROR_SEGMENT')
        },
        transactionError: {
          kind: SegmentKind.REPLY,
          transactionFlags: {
            sessionClosingTransactionErrror: true
          }
        },
        parseError: new Error('PARSE_ERROR'),
        noError: {
          kind: SegmentKind.REPLY
        },
      };
      connection._parseReplySegment = function parseReplySegment(buffer) {
        var reply = replies[buffer.toString()];
        if (reply instanceof Error) {
          throw reply;
        }
        return reply;
      };
      connection.receive(new Buffer('noError'), function (err, reply) {
        (!!err).should.be.not.ok;
        reply.should.equal(replies.noError);
      });
      connection.receive(new Buffer('errorSegment'), function (err) {
        err.should.equal(replies.errorSegment.error);
      });
      connection.receive(new Buffer('parseError'), function (err) {
        err.should.equal(replies.parseError);
      });
      connection.receive(new Buffer('transactionError'), function (err) {
        err.code.should.equal('EHDBTX');
      });
    });

    it('should enqueue a mesage', function () {
      var connection = createConnection();
      connection._queue.pause();
      connection.enqueue(function firstTask() {});
      connection.enqueue(new lib.request.Segment(MessageType.EXECUTE));
      connection.enqueue({
        name: 'thirdTask',
        run: function () {}
      });
      var taskNames = connection._queue.queue.map(function taskName(task) {
        return task.name;
      });
      taskNames.should.eql(['firstTask', 'EXECUTE', 'thirdTask']);
    });

    it('should rollback a transaction', function () {
      var connection = createConnection();
      connection.enqueue = function enqueue(msg, done) {
        done(msg);
      };

      function cb(msg) {
        msg.type.should.equal(MessageType.ROLLBACK);
      }
      connection.rollback(cb);
      connection.rollback({}, cb);
    });

    it('should commit a transaction', function () {
      var connection = createConnection();
      connection.enqueue = function enqueue(msg, done) {
        done(msg);
      };

      function cb(msg) {
        msg.type.should.equal(MessageType.COMMIT);
      }
      connection.commit(cb);
      connection.commit({}, cb);
    });

    it('should execute a statement', function () {
      var connection = createConnection();
      connection.enqueue = function enqueue(msg, done) {
        done(msg);
      };

      function cb(msg) {
        msg.type.should.equal(MessageType.EXECUTE);
      }
      connection.execute({}, cb);
    });

    it('should connect to the database', function (done) {
      var connection = createConnection();
      var settings = connection._settings;
      var credentials = {};
      connection._createAuthenticationManager = function createManager(options) {
        options.should.equal(credentials);
        var manager = mock.createManager(options);
        manager.sessionCookie = 'cookie';
        return manager;
      };
      connection.send = sendAuthenticationRequest;
      connection.connect(credentials, function (err, reply) {
        (!!err).should.be.not.ok;
        reply.authentication.should.equal('FINAL');
        settings.sessionCookie.should.equal('cookie');
        done();
      });
    });


    it('should fail to create the authentication manager', function (done) {
      var connection = createConnection();
      var authError = new Error('AUTHENTICATION_ERROR');
      connection._createAuthenticationManager = function createManager() {
        throw authError;
      };

      connection.connect({}, function (err) {
        err.should.equal(authError);
        done();
      });
    });

    it('should receive an authentication error', function (done) {
      var connection = createConnection();
      var error = new Error('AUTHENTICATION_ERROR');
      connection._createAuthenticationManager = mock.createManager;
      connection.send = sendAuthenticationRequest;
      connection.connect({
        initialDataError: error
      }, function (err) {
        err.should.equal(error);
        done();
      });
    });

    it('should receive a connect error', function (done) {
      var connection = createConnection();
      var error = new Error('CONNECT_ERROR');
      connection._createAuthenticationManager = mock.createManager;
      connection.send = sendAuthenticationRequest;
      connection.connect({
        finalDataError: error
      }, function (err) {
        err.should.equal(error);
        done();
      });
    });

    it('should fail to initialize authentication manager', function (done) {
      var connection = createConnection();
      var error = new Error('INITIALIZE_ERROR');
      connection._createAuthenticationManager = mock.createManager;
      connection.send = sendAuthenticationRequest;
      connection.connect({
        initializeError: error
      }, function (err) {
        err.should.equal(error);
        done();
      });
    });

    it('should fail to disconnect from the database', function (done) {
      var connection = createConnection();
      var error = new Error('DISCONNECT_ERROR');
      connection.enqueue = function enqueue(msg, cb) {
        msg.type.should.equal(MessageType.DISCONNECT);
        setImmediate(function () {
          cb(error);
        });
      };
      var queue = connection._queue;
      queue.pause();
      var queueable = queue.createTask(function (cb) {
        cb();
      }, function () {});
      queueable.name = 'dummy';
      queue.push(queueable);
      connection.disconnect(function (err) {
        err.should.equal(error);
        done();
      });
      queue.resume();
    });

  });
});