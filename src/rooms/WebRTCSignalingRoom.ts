import { Room, Client } from "colyseus";
import winston from "winston";
import { getLogger } from "..";

export class WebRTCSignalingRoom extends Room {
    private logger: winston.Logger;

    onCreate(options: any) {
      this.logger = getLogger();
      this.autoDispose = false;
      this.maxClients = Number(process.env.MAX_CLIENTS || 500);
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
      this.logger.info(`[signaling] ${client.sessionId} joined!`);
    }
  
    onLeave(client: Client, consented: boolean) {
      this.logger.info(`[signaling] ${client.sessionId} left!`);
    }
  
    onDispose() {
      this.logger.info(`[signaling] room ${this.roomId} disposing...`);
    }
  
}