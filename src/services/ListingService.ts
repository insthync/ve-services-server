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
        const app = this.app;
        const gameServers = this.gameServers;

        app.get('/listing', (req, res) => {
            const result = [];
            for (const key in gameServers) {
                if (Object.hasOwnProperty.call(gameServers, key)) {
                    result.push(gameServers[key]);
                }
            }
            res.status(200).send({
                success: true,
                gameServers: result,
            });
        });

        app.get('/listing/total-player', (req, res) => {
            let totalPlayer = 0;
            for (const key in gameServers) {
                if (Object.hasOwnProperty.call(gameServers, key)) {
                    totalPlayer += gameServers[key].currentPlayer;
                }
            }
            res.status(200).send({
                success: true,
                totalPlayer,
            });
        });
    }

    public onCreateRoom(room: ListingRoom) {
        const gameServers = this.gameServers;

        room.onMessage('update', (client: Client, msg: IGameServerData) => {
            const id = client.id;
            if (id !== undefined && id in gameServers) {
                msg.id = id;
                gameServers[id] = msg;
            }
        });
    }

    public onConnect(client: Client, options: any) {
        const logger = this.logger;
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
        logger.info(`[listing] Game-Server: ${client.id} connected.`);
    }

    public onDisconnect(client: Client) {
        const logger = this.logger;
        const id = client.id;
        if (id !== undefined && id in this.gameServers) {
            delete this.gameServers[id];
            logger.info(`[listing] Game-Server: ${id} shutdown.`);
        } else {
            logger.info(`[listing] No connected Game-Server: ${id}, so it can be shutdown.`);
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