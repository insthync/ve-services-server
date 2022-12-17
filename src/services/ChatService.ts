import winston from "winston";
import express from "express";
import { PrismaClient } from '@prisma/client'
import { nanoid } from "nanoid";
import { Client } from "colyseus";
import { ChatRoom } from "../rooms/ChatRoom";

export class ChatService {
    private app: express.Express;
    private logger: winston.Logger;
    private prisma: PrismaClient;
    private connectingUsers: { [id: string]: IClientData } = {}
    private connections: { [id: string]: Client } = {}
    private connectionsByName: { [name: string]: Client } = {}
    private connectionsByGroupId: { [groupId: string]: { [id: string]: Client } } = {}

    constructor(app: express.Express, logger: winston.Logger) {
        this.app = app;
        this.logger = logger;
        this.prisma = new PrismaClient();
        this.setupRoutes();
    }

    setupRoutes() {
        const app = this.app;
        const prisma = this.prisma;
        const connectingUsers = this.connectingUsers;
        const validateUser = this.validateSystem;

        app.post('/chat/add-user', validateUser, async (req, res, next) => {
            // Token is correct, then create user connection data
            const connectingUser = {
                userId: req.body.userId,
                name: req.body.name,
                connectionKey: nanoid(6),
            } as IClientData
            connectingUsers[connectingUser.userId] = connectingUser
            const user = await prisma.user.findUnique({
                where: {
                    userId: req.body.userId,
                }
            })
            if (user) {
                await prisma.user.update({
                    where: {
                        userId: req.body.userId,
                    },
                    data: {
                        name: req.body.name,
                        iconUrl: req.body.iconUrl,
                    }
                })
            } else {
                await prisma.user.create({
                    data: {
                        userId: req.body.userId,
                        name: req.body.name,
                        iconUrl: req.body.iconUrl,
                    }
                })
            }
            // Send response back
            res.status(200).send(connectingUser)
        })

        app.post('/chat/remove-user', validateUser, async (req, res, next) => {
            delete connectingUsers[req.body.userId]
            res.status(200).send()
        })
    }

    validateSystem(req: any, res: any, next: any) {
        // This must be able to connect by game-server only, don't allow client to connect
        // Validate connection by secret key which will be included in header -> authorization
        const bearerHeader = req.headers['authorization']
        if (!bearerHeader) {
            res.sendStatus(400)
            return
        }
        // Substring `bearer `, length is 7
        const bearerToken = bearerHeader.substring(7)
        const secretKeys: string[] = JSON.parse(process.env.SECRET_KEYS || "[]")
        if (secretKeys.indexOf(bearerToken) < 0) {
            res.sendStatus(400)
            return
        }
        next();
    }

    async GroupLeave(groupId: string | undefined, userId: string | undefined) {
        const prisma = this.prisma;
        const connectionsByGroupId = this.connectionsByGroupId;
        const NotifyGroup = this.NotifyGroup;

        // Validate group
        if (!groupId) {
            return
        }
        // Validate user
        if (!userId) {
            return
        }
        // Delete user's group data from database
        await prisma.userGroup.deleteMany({
            where: {
                userId: userId,
                groupId: groupId,
            }
        })
        // Valiate before send group moving message to clients
        if (!Object.prototype.hasOwnProperty.call(connectionsByGroupId, groupId)) {
            return
        }
        if (!Object.prototype.hasOwnProperty.call(connectionsByGroupId[groupId], userId)) {
            return
        }
        // Remove user from the group
        await NotifyGroup(userId)
        delete connectionsByGroupId[groupId][userId]
        // Broadcast leave member
        const targetClients = connectionsByGroupId[groupId]
        for (const targetUserId in targetClients) {
            const targetClient = targetClients[targetUserId]
            targetClient.send("group-leave", {
                groupId: groupId,
            })
        }
    }

    async NotifyGroupInvitation(userId: string) {
        const prisma = this.prisma;
        const connections = this.connections;

        const list = await prisma.userGroupInvitation.findMany({
            where: {
                userId: userId,
            }
        })
        const groupIds: Array<string> = []
        list.forEach(element => {
            groupIds.push(element.groupId)
        })
        const groupList = await prisma.group.findMany({
            where: {
                groupId: {
                    in: groupIds
                }
            }
        })
        if (Object.prototype.hasOwnProperty.call(connections, userId)) {
            const connection = connections[userId]
            connection.send("group-invitation-list", {
                list: groupList
            })
        }
    }

    async NotifyGroupUser(userId: string, groupId: string) {
        const prisma = this.prisma;
        const connections = this.connections;

        const list = await prisma.userGroup.findMany({
            where: {
                groupId: groupId,
            }
        })
        const userIds: Array<string> = []
        list.forEach(element => {
            userIds.push(element.userId)
        })
        const userList = await prisma.user.findMany({
            where: {
                userId: {
                    in: userIds
                }
            }
        })

        if (Object.prototype.hasOwnProperty.call(connections, userId)) {
            const connection = connections[userId]
            connection.send("group-user-list", {
                groupId: groupId,
                list: userList
            })
        }
    }

    async NotifyGroup(userId: string) {
        const prisma = this.prisma;
        const connections = this.connections;

        const list = await prisma.userGroup.findMany({
            where: {
                userId: userId,
            }
        })
        const groupIds: Array<string> = []
        list.forEach(element => {
            groupIds.push(element.groupId)
        })
        const groupList = await prisma.group.findMany({
            where: {
                groupId: {
                    in: groupIds
                }
            }
        })
        if (Object.prototype.hasOwnProperty.call(connections, userId)) {
            const connection = connections[userId]
            connection.send("group-list", {
                list: groupList
            })
        }
    }

    async AddUserToGroup(userId: string, groupId: string) {
        const prisma = this.prisma;
        const connections = this.connections;
        const connectionsByGroupId = this.connectionsByGroupId;
        const NotifyGroupInvitation = this.NotifyGroupInvitation;
        const NotifyGroup = this.NotifyGroup;

        await prisma.userGroup.deleteMany({
            where: {
                userId: userId,
                groupId: groupId,
            }
        })
        await prisma.userGroup.create({
            data: {
                userId: userId,
                groupId: groupId,
            }
        })
        if (!Object.prototype.hasOwnProperty.call(connectionsByGroupId, groupId)) {
            connectionsByGroupId[groupId] = {}
        }
        // Add user to group
        if (Object.prototype.hasOwnProperty.call(connections, userId)) {
            const socket = connections[userId]
            connectionsByGroupId[groupId][userId] = socket
        }
        // Broadcast new member
        const targetClients = connectionsByGroupId[groupId]
        for (const targetUserId in targetClients) {
            const targetClient = targetClients[targetUserId]
            targetClient.send("group-join", {
                "groupId": groupId,
                "userId": targetClient.userData.userId,
                "name": targetClient.userData.name,
            })
        }
        await NotifyGroupInvitation(userId)
        await NotifyGroup(userId)
    }
}

interface IClientData {
    userId: string;
    name: string;
    connectionKey: string;
}