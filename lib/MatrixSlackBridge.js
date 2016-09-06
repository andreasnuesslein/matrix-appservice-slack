"use strict";

var bridgeLib = require("matrix-appservice-bridge");
var Bridge = bridgeLib.Bridge;

var SlackHookHandler = require("./SlackHookHandler");
var BridgedRoom = require("./BridgedRoom");

var AdminCommands = require("./AdminCommands");

function MatrixSlackBridge(config) {
    var self = this;

    this._config = config;

    this._recentMatrixEventIds = new Array(20);
    this._mostRecentEventIdIdx = 0;

    this._rooms = [];
    this._roomsBySlackChannelId = {};
    this._roomsByMatrixRoomId = {};

    config.rooms.forEach((room_config) => {
        var room = new BridgedRoom({
            bridge: this,

            slack_channel_id: room_config.slack_channel_id,
            slack_token: room_config.slack_api_token,
            slack_webhook_uri: room_config.webhook_url,
        });

        this.addBridgedRoom(room);

        if (room_config.matrix_room_ids) {
            room_config.matrix_room_ids.forEach((id) => {
                this.linkRoomToMatrix(room, id);
            });
        }
        else if (room_config.matrix_room_id) {
            this.linkRoomToMatrix(room, room_config.matrix_room_id);
        }
        else {
            throw Error("Expected either 'matrix_room_ids' or 'matrix_room_id'" +
                        " for slack channel ID " + room_config.slack_channel_id);
        }
    });

    this._bridge = new Bridge({
        homeserverUrl: config.homeserver.url,
        domain: config.homeserver.server_name,
        registration: "slack-registration.yaml",

        controller: {
            onUserQuery: function(queriedUser) {
                return {}; // auto-provision users with no additonal data
            },

            onEvent: function(request, context) {
                var ev = request.getData();
                self.onMatrixEvent(ev);
            },
        }
    });

    this._slackHookHandler = new SlackHookHandler(this);
}

MatrixSlackBridge.prototype.getRoomStore = function() {
    return this._bridge.getRoomStore()
};

MatrixSlackBridge.prototype.getUrlForMxc = function(mxc_url) {
    return this._config.homeserver.url + "/_matrix/media/v1/download/" +
        mxc_url.substring("mxc://".length);
};

MatrixSlackBridge.prototype.getTeamToken = function(team_domain) {
    // TODO(paul): move this into a mapping at least, if not full DB
    return this._config["slack_token_" + team_domain];
};

MatrixSlackBridge.prototype.getBotIntent = function() {
    return this._bridge.getIntent();
};

MatrixSlackBridge.prototype.getIntentForSlackUsername = function(slackUser) {
    var username = "@" + this._config.username_prefix + slackUser +
        ":" + this._config.homeserver.server_name;
    return this._bridge.getIntent(username);
};

MatrixSlackBridge.prototype.addBridgedRoom = function(room) {
    this._rooms.push(room);
    this._roomsBySlackChannelId[room.getSlackChannelId()] = room;
};

MatrixSlackBridge.prototype.getRoomBySlackChannelId = function(channel_id) {
    return this._roomsBySlackChannelId[channel_id];
};

MatrixSlackBridge.prototype.linkRoomToMatrix = function(room, matrix_room_id) {
    room.addMatrixRoomId(matrix_room_id);
    this._roomsByMatrixRoomId[matrix_room_id] = room;
};

MatrixSlackBridge.prototype.unlinkRoomFromMatrix = function(room, matrix_room_id) {
    if (!room.removeMatrixRoomId(matrix_room_id)) return false;

    delete this._roomsByMatrixRoomId[matrix_room_id];
    return true;
};

MatrixSlackBridge.prototype.getRoomByMatrixRoomId = function(room_id) {
    return this._roomsByMatrixRoomId[room_id];
};

MatrixSlackBridge.prototype.onMatrixEvent = function(ev) {
    // simple de-dup
    var recents = this._recentMatrixEventIds;
    for (var i = 0; i < recents.length; i++) {
        if (recents[i] != undefined && recents[i] == ev.ev_id) {
          // move the most recent ev to where we found a dup and add the
          // duplicate at the end (reasoning: we only want one of the
          // duplicated ev_id in the list, but we want it at the end)
          recents[i] = recents[this._mostRecentEventIdIdx];
          recents[this._mostRecentEventIdIdx] = ev.ev_id;
          console.log("Ignoring duplicate ev: " + ev.ev_id);
          return;
        }
    }
    this._mostRecentEventIdIdx = (this._mostRecentEventIdIdx + 1) % 20;
    recents[this._mostRecentEventIdIdx] = ev.ev_id;

    var myUserId = this._bridge.getBot().getUserId();

    if (ev.type === "m.room.member" && ev.state_key === myUserId) {
        // A membership event about myself
        var membership = ev.content.membership;
        if (membership === "invite") {
            // Automatically accept all invitations
            this.getBotIntent().join(ev.room_id);
        }

        return;
    }

    if (ev.sender === myUserId) return;
    if (ev.type !== "m.room.message" || !ev.content) return;

    if (this._config.matrix_admin_room && ev.room_id === this._config.matrix_admin_room) {
        this.onMatrixAdminMessage(ev);
        return;
    }

    var room = this.getRoomByMatrixRoomId(ev.room_id);
    if (!room) {
        console.log("Ignoring ev for matrix room with unknown slack channel:" +
            ev.room_id);
        return;
    }
    room.onMatrixMessage(ev);
};

MatrixSlackBridge.prototype.onMatrixAdminMessage = function(ev) {
    var cmd = ev.content.body;
    console.log("Admin: " + cmd);

    var intent = this.getBotIntent();
    function respond(message) {
        intent.sendText(ev.room_id, ev.user_id + ": " + message);
    };
    // Split the command string into optionally-quoted whitespace-separated
    //   tokens. The quoting preserves whitespace within quoted forms
    // TODO(paul): see if there's a "split like a shell does" function we can use
    //   here instead.
    var args = cmd.match(/(?:[^\s"]+|"[^"]*")+/g);
    cmd = args.shift();

    var c = AdminCommands[cmd];
    if (c) {
        try {
            c.run(this, args, respond);
        }
        catch (e) {
            respond("Command failed: " + e);
        }
    }
    else {
        respond("Unrecognised command: " + cmd);
    }
};

MatrixSlackBridge.prototype.actionLink = function(opts) {
    var matrix_room_id = opts.matrix_room_id;

    var _getOrMakeRoom = () => {
        var room = this.getRoomBySlackChannelId(opts.slack_channel_id);
        if (room) return Promise.resolve(room);

        if (!opts.slack_webhook_uri) {
            return Promise.reject("Unable to create BridgedRoom - unspecified slack_webhook_uri");
        }
        if (!opts.slack_token) {
            return Promise.reject("Unable to create BridgedRoom - unspecified slack_token");
        }

        room = new BridgedRoom(opts);

        return this.getRoomStore().insert(room.toEntry()).then(() => {
            this.addBridgedRoom(room);
            return room;
        });
    }
    return _getOrMakeRoom().then((room) => {
        var slack_channel_id = room.getSlackChannelId();
        var linkId = matrix_room_id + " " + slack_channel_id;

        this.linkRoomToMatrix(room, matrix_room_id);
        return this.getRoomStore().insert({
            id: linkId,
            matrix_id: matrix_room_id,
            remote_id: slack_channel_id,
        }).then(() => {
            console.log("LINKED " + matrix_room_id + " to " + slack_channel_id);
        });
    });
};

MatrixSlackBridge.prototype.actionUnlink = function(opts) {
    var room = this.getRoomBySlackChannelId(opts.slack_channel_id);
    if (!room) {
        return Promise.reject("Cannot unlink - unknown channel");
    }

    if (room.matrix_room_id !== opts.matrix_room_id) {
        return Promise.reject("Cannot unlink - not linked to this room");
    }

    var linkId = room.matrix_room_id + " " + room.slack_channel_id;
    return this.getRoomStore().delete({id: linkId}).then(() => {
        delete this._roomsBySlackChannelId[opts.slack_channel_id];
        delete this._roomsByMatrixRoomId[opts.matrix_room_id];
        this._rooms.splice(this._rooms.indexOf(room), 1);
    });
};

MatrixSlackBridge.prototype.run = function(port) {
    var bridge = this._bridge;
    var config = this._config;

    bridge.loadDatabases().then(() => {
        return this.getRoomStore().select({
            remote_id: {$exists: true},
            matrix_id: {$exists: false},
        })
    }).then((entries) => {
        entries.forEach((entry) => {
            var room = BridgedRoom.fromEntry(this, entry);
            this.addBridgedRoom(room);
        });
    }).then(() => {
        return this.getRoomStore().select({
            remote_id: {$exists: true},
            matrix_id: {$exists: true},
        });
    }).then((entries) => {
        entries.forEach((entry) => {
            var room = this.getRoomBySlackChannelId(entry.remote_id);
            if (room) {
                this.linkRoomToMatrix(room, entry.matrix_id);
            }
        });
    });

    this._slackHookHandler.startAndListen(
        config.slack_hook_port, config.tls
    ).then(() => {
        bridge.run(port, config);
    });
}

module.exports = MatrixSlackBridge;