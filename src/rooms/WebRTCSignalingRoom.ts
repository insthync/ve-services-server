import { Room, Client, ServerError } from "colyseus";
import http from "http";
import winston from "winston";
import { getLogger, getChatService } from "..";
import { WebRTCPeer } from "./schema/WebRTCPeer";
import { WebRTCSignalingRoomState } from "./schema/WebRTCSignalingRoomState";

export class WebRTCSignalingRoom extends Room<WebRTCSignalingRoomState> {
    private logger: winston.Logger;

    onCreate(options: any) {
      this.logger = getLogger();
      this.setState(new WebRTCSignalingRoomState());
      this.autoDispose = false;
      this.onMessage("candidate", this.onCandidate.bind(this));
      this.onMessage("desc", this.onDesc.bind(this));
    }
  
    onCandidate(client: Client, message: any) {
      for (let index = 0; index < this.clients.length; index++) {
        const value = this.clients[index];
        if (value.sessionId == message.sessionId) {
          message.sessionId = client.sessionId;
          value.send("candidate", message);
          break;
        }
      }
    }
  
    onDesc(client: Client, message: any) {
      for (let index = 0; index < this.clients.length; index++) {
        const value = this.clients[index];
        if (value.sessionId == message.sessionId) {
          message.sessionId = client.sessionId;
          value.send("desc", message);
          break;
        }
      }
    }
  
    onJoin(client: Client, options: any) {
      console.log(client.sessionId, "joined!");
      this.state.players.set(client.sessionId, new WebRTCPeer().assign({
        sessionId: client.sessionId,
      }));
    }
  
    onLeave(client: Client, consented: boolean) {
      console.log(client.sessionId, "left!");
      this.state.players.delete(client.sessionId);
    }
  
    onDispose() {
      console.log("room", this.roomId, "disposing...");
    }
  
}