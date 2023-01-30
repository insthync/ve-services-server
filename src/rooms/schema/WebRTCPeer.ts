import { Schema, type } from "@colyseus/schema";

export class WebRTCPeer extends Schema {
    @type("string")
    sessionId: string = "";
    @type("string")
    id: string = "";
}