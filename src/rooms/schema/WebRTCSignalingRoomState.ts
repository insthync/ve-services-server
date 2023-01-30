import { Schema, MapSchema, type } from "@colyseus/schema";
import { WebRTCPeer } from "./WebRTCPeer";

export class WebRTCSignalingRoomState extends Schema {
  @type({ map: WebRTCPeer })
  players = new MapSchema<WebRTCPeer>();
}
