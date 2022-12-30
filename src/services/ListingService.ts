import winston from "winston";
import express from "express";
import { Client } from "colyseus";
import { ListingRoom } from "../rooms/ListingRoom";

export class ListingService {
    private app: express.Express;
    private logger: winston.Logger;
    private gameServers: { [id: string]: IGameServerData } = {};

    constructor(app: express.Express, logger: winston.Logger) {
        this.app = app;
        this.logger = logger;
        this.setupRoutes();
    }

    setupRoutes() {
        this.app.get('/listing', this.onGetList.bind(this));
        this.app.get('/listing/total-player', this.onGetTotalPlayer.bind(this));
    }

    onGetList(req: express.Request, res: express.Response) {
        const result = [];
        for (const key in this.gameServers) {
            if (Object.hasOwnProperty.call(this.gameServers, key)) {
                result.push(this.gameServers[key]);
            }
        }
        res.status(200).send({
            success: true,
            gameServers: result,
        });
    }

    onGetTotalPlayer(req: express.Request, res: express.Response) {
        let totalPlayer = 0;
        for (const key in this.gameServers) {
            if (Object.hasOwnProperty.call(this.gameServers, key)) {
                totalPlayer += this.gameServers[key].currentPlayer;
            }
        }
        res.status(200).send({
            success: true,
            totalPlayer,
        });
    }

    public onCreateRoom(room: ListingRoom) {
        room.onMessage('update', this.onUpdate.bind(this));
    }

    onUpdate(client: Client, msg: IGameServerData) {
        const id = client.id;
        if (id !== undefined && id in this.gameServers) {
            msg.id = id;
            this.gameServers[id] = msg;
        }
    }

    public onConnect(client: Client, options: any) {
        const gameServer: IGameServerData = {
            id: client.id,
            address: options.data.address,
            port: options.data.port,
            title: options.data.title,
            description: options.data.description,
            map: options.data.map,
            currentPlayer: options.data.currentPlayer,
            maxPlayer: options.data.maxPlayer,
        };
        this.gameServers[gameServer.id] = gameServer;
        this.logger.info(`[listing] Game-Server: ${client.id} connected.`);
    }

    public onDisconnect(client: Client) {
        const id = client.id;
        if (id !== undefined && id in this.gameServers) {
            delete this.gameServers[id];
            this.logger.info(`[listing] Game-Server: ${id} shutdown.`);
        } else {
            this.logger.info(`[listing] No connected Game-Server: ${id}, so it can be shutdown.`);
        }
    }
}

interface IGameServerData {
    id: string,
    address: string,
    port: number,
    title: string,
    description: string,
    map: string,
    currentPlayer: number,
    maxPlayer: number,
}