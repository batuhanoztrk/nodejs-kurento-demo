/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

const path = require("path");
const express = require("express");
const ws = require("ws");
const minimist = require("minimist");
const url = require("url");
const kurento = require("kurento-client");
const fs = require("fs");
const http = require("http");

const argv = minimist(process.argv.slice(2), {
  default: {
    ws_uri: "ws://128.140.119.57:8888/kurento",
  },
});

const app = express();

/*
 * Definition of global variables.
 */

let kurentoClient = null;
const userRegistry = new UserRegistry();
const pipelines = {};
const candidatesQueue = {};
let idCounter = 0;

function nextUniqueId () {
  idCounter++;
  return idCounter.toString();
}

/*
 * Definition of helper classes
 */

// Represents caller and callee sessions
function UserSession (id, name, ws) {
  this.id = id;
  this.name = name;
  this.ws = ws;
  this.peer = null;
  this.sdpOffer = null;
}

UserSession.prototype.sendMessage = function (message) {
  this.ws.send(JSON.stringify(message));
};

// Represents registrar of users
function UserRegistry () {
  this.usersById = {};
  this.usersByName = {};
}

UserRegistry.prototype.register = function (user) {
  this.usersById[user.id] = user;
  this.usersByName[user.name] = user;
};

UserRegistry.prototype.unregister = function (id) {
  const user = this.getById(id);
  if (user) delete this.usersById[id];
  if (user && this.getByName(user.name)) delete this.usersByName[user.name];
};

UserRegistry.prototype.getById = function (id) {
  return this.usersById[id];
};

UserRegistry.prototype.getByName = function (name) {
  return this.usersByName[name];
};

UserRegistry.prototype.removeById = function (id) {
  const userSession = this.usersById[id];
  if (!userSession) return;
  delete this.usersById[id];
  delete this.usersByName[userSession.name];
};

// Represents a B2B active call
function CallMediaPipeline () {
  this.pipeline = null;
  this.webRtcEndpoint = {};
  this.recorderEndpoint = {};
}

CallMediaPipeline.prototype.createPipeline = function (
  callerId, calleeId, ws, callback) {
  const self = this;
  getKurentoClient(function (error, kurentoClient) {
    if (error) {
      return callback(error);
    }

    kurentoClient.create("MediaPipeline", function (error, pipeline) {
      if (error) {
        return callback(error);
      }

      pipeline.create("RecorderEndpoint",
        { uri: "file:///tmp/" + callerId + ".webm" },
        function (error, callerRecorder) {

          pipeline.create("WebRtcEndpoint",
            function (error, callerWebRtcEndpoint) {
              if (error) {
                pipeline.release();
                return callback(error);
              }

              if (candidatesQueue[callerId]) {
                while (candidatesQueue[callerId].length) {
                  const candidate = candidatesQueue[callerId].shift();
                  callerWebRtcEndpoint.addIceCandidate(candidate);
                }
              }

              callerWebRtcEndpoint.on("IceCandidateFound", function (event) {
                const candidate = kurento.getComplexType("IceCandidate")(
                  event.candidate);
                userRegistry.getById(callerId).ws.send(JSON.stringify({
                  id: "iceCandidate",
                  candidate: candidate,
                }));
              });

              pipeline.create("RecorderEndpoint",
                { uri: "file:///tmp/" + calleeId + ".webm" },
                function (error, calleeRecorder) {
                  pipeline.create("WebRtcEndpoint",
                    function (error, calleeWebRtcEndpoint) {
                      if (error) {
                        pipeline.release();
                        return callback(error);
                      }

                      if (candidatesQueue[calleeId]) {
                        while (candidatesQueue[calleeId].length) {
                          const candidate = candidatesQueue[calleeId].shift();
                          calleeWebRtcEndpoint.addIceCandidate(candidate);
                        }
                      }

                      calleeWebRtcEndpoint.on("IceCandidateFound",
                        function (event) {
                          const candidate = kurento.getComplexType(
                            "IceCandidate")(
                            event.candidate);
                          userRegistry.getById(calleeId).
                            ws.
                            send(JSON.stringify({
                              id: "iceCandidate",
                              candidate: candidate,
                            }));
                        });

                      callerWebRtcEndpoint.connect(callerRecorder,
                        function (error) {
                          callerWebRtcEndpoint.connect(calleeWebRtcEndpoint,
                            function (error) {
                              if (error) {
                                pipeline.release();
                                return callback(error);
                              }

                              calleeWebRtcEndpoint.connect(calleeRecorder,
                                function (error) {
                                  calleeWebRtcEndpoint.connect(
                                    callerWebRtcEndpoint,
                                    function (error) {
                                      if (error) {
                                        pipeline.release();
                                        return callback(error);
                                      }
                                    });
                                });

                              callerRecorder.record();
                              calleeRecorder.record();

                              calleeWebRtcEndpoint.connect;

                              self.pipeline = pipeline;
                              self.webRtcEndpoint[callerId] = callerWebRtcEndpoint;
                              self.webRtcEndpoint[calleeId] = calleeWebRtcEndpoint;
                              self.recorderEndpoint[callerId] = callerRecorder;
                              self.recorderEndpoint[calleeId] = calleeRecorder;
                              callback(null);
                            });
                        });
                    });
                });

            });

        });
    });
  });
};

CallMediaPipeline.prototype.generateSdpAnswer = function (
  id, sdpOffer, callback) {
  this.webRtcEndpoint[id].processOffer(sdpOffer, callback);
  this.webRtcEndpoint[id].gatherCandidates(function (error) {
    if (error) {
      return callback(error);
    }
  });
};

CallMediaPipeline.prototype.release = function () {
  if (this.pipeline) this.pipeline.release();
  this.pipeline = null;
};

/*
 * Server startup
 */

const port = 8443;
const server = http.createServer(app).listen(port, function () {
  console.log("Kurento Tutorial started");
  console.log("Open localhost:8443 with a WebRTC capable browser");
});

const wss = new ws.Server({
  server: server,
  path: "/one2one",
});

wss.on("connection", function (ws) {
  const sessionId = nextUniqueId();
  console.log("Connection received with sessionId " + sessionId);

  ws.on("error", function (error) {
    console.log("Connection " + sessionId + " error");
    stop(sessionId);
  });

  ws.on("close", function () {
    console.log("Connection " + sessionId + " closed");
    stop(sessionId);
    userRegistry.unregister(sessionId);
  });

  ws.on("message", function (_message) {
    const message = JSON.parse(_message);
    console.log("Connection " + sessionId + " received message ", message);

    switch (message.id) {
      case "register":
        register(sessionId, message.name, ws);
        break;

      case "call":
        call(sessionId, message.to, message.from, message.sdpOffer);
        break;

      case "incomingCallResponse":
        incomingCallResponse(sessionId, message.from, message.callResponse,
          message.sdpOffer, ws);
        break;

      case "stop":
        stop(sessionId);
        break;

      case "onIceCandidate":
        onIceCandidate(sessionId, message.candidate);
        break;

      default:
        ws.send(JSON.stringify({
          id: "error",
          message: "Invalid message " + message,
        }));
        break;
    }

  });
});

// Recover kurentoClient for the first time.
function getKurentoClient (callback) {
  if (kurentoClient !== null) {
    return callback(null, kurentoClient);
  }

  kurento(argv.ws_uri, function (error, _kurentoClient) {
    if (error) {
      const message = "Coult not find media server at address " + argv.ws_uri;
      return callback(message + ". Exiting with error " + error);
    }

    kurentoClient = _kurentoClient;
    callback(null, kurentoClient);
  });
}

function stop (sessionId) {
  if (!pipelines[sessionId]) {
    return;
  }

  const pipeline = pipelines[sessionId];
  delete pipelines[sessionId];
  pipeline.release();
  const stopperUser = userRegistry.getById(sessionId);
  const stoppedUser = userRegistry.getByName(stopperUser.peer);
  stopperUser.peer = null;

  if (stoppedUser) {
    stoppedUser.peer = null;
    delete pipelines[stoppedUser.id];
    const message = {
      id: "stopCommunication",
      message: "remote user hanged out",
    };
    stoppedUser.sendMessage(message);
  }

  clearCandidatesQueue(sessionId);
}

function incomingCallResponse (calleeId, from, callResponse, calleeSdp, ws) {

  clearCandidatesQueue(calleeId);

  function onError (callerReason, calleeReason) {
    if (pipeline) pipeline.release();
    if (caller) {
      const callerMessage = {
        id: "callResponse",
        response: "rejected",
      };
      if (callerReason) callerMessage.message = callerReason;
      caller.sendMessage(callerMessage);
    }

    const calleeMessage = {
      id: "stopCommunication",
    };
    if (calleeReason) calleeMessage.message = calleeReason;
    callee.sendMessage(calleeMessage);
  }

  const callee = userRegistry.getById(calleeId);
  if (!from || !userRegistry.getByName(from)) {
    return onError(null, "unknown from = " + from);
  }
  const caller = userRegistry.getByName(from);

  if (callResponse === "accept") {
    const pipeline = new CallMediaPipeline();
    pipelines[caller.id] = pipeline;
    pipelines[callee.id] = pipeline;

    pipeline.createPipeline(caller.id, callee.id, ws, function (error) {
      if (error) {
        return onError(error, error);
      }

      pipeline.generateSdpAnswer(caller.id, caller.sdpOffer,
        function (error, callerSdpAnswer) {
          if (error) {
            return onError(error, error);
          }

          pipeline.generateSdpAnswer(callee.id, calleeSdp,
            function (error, calleeSdpAnswer) {
              if (error) {
                return onError(error, error);
              }

              let message = {
                id: "startCommunication",
                sdpAnswer: calleeSdpAnswer,
              };
              callee.sendMessage(message);

              message = {
                id: "callResponse",
                response: "accepted",
                sdpAnswer: callerSdpAnswer,
              };
              caller.sendMessage(message);
            });
        });
    });
  } else {
    const decline = {
      id: "callResponse",
      response: "rejected",
      message: "user declined",
    };
    caller.sendMessage(decline);
  }
}

function call (callerId, to, from, sdpOffer) {
  clearCandidatesQueue(callerId);

  const caller = userRegistry.getById(callerId);
  let rejectCause = "User " + to + " is not registered";
  if (userRegistry.getByName(to)) {
    const callee = userRegistry.getByName(to);
    caller.sdpOffer = sdpOffer;
    callee.peer = from;
    caller.peer = to;
    const message = {
      id: "incomingCall",
      from: from,
    };
    try {
      return callee.sendMessage(message);
    } catch (exception) {
      rejectCause = "Error " + exception;
    }
  }
  const message = {
    id: "callResponse",
    response: "rejected: ",
    message: rejectCause,
  };
  caller.sendMessage(message);
}

function register (id, name, ws, callback) {
  function onError (error) {
    ws.send(JSON.stringify(
      { id: "registerResponse", response: "rejected ", message: error }));
  }

  if (!name) {
    return onError("empty user name");
  }

  if (userRegistry.getByName(name)) {
    return onError("User " + name + " is already registered");
  }

  userRegistry.register(new UserSession(id, name, ws));
  try {
    ws.send(JSON.stringify({ id: "registerResponse", response: "accepted" }));
  } catch (exception) {
    onError(exception);
  }
}

function clearCandidatesQueue (sessionId) {
  if (candidatesQueue[sessionId]) {
    delete candidatesQueue[sessionId];
  }
}

function onIceCandidate (sessionId, _candidate) {
  const candidate = kurento.getComplexType("IceCandidate")(_candidate);
  const user = userRegistry.getById(sessionId);

  if (pipelines[user.id] && pipelines[user.id].webRtcEndpoint &&
    pipelines[user.id].webRtcEndpoint[user.id]) {
    const webRtcEndpoint = pipelines[user.id].webRtcEndpoint[user.id];
    webRtcEndpoint.addIceCandidate(candidate);
  } else {
    if (!candidatesQueue[user.id]) {
      candidatesQueue[user.id] = [];
    }
    candidatesQueue[sessionId].push(candidate);
  }
}

app.use(express.static(path.join(__dirname, "static")));
