import winston from "winston";
import express from "express";
import { Profanity } from "@2toad/profanity";
import { PrismaClient, Group, User } from '@prisma/client'
import { nanoid } from "nanoid";
import { Client } from "colyseus";
import { ChatRoom } from "../rooms/ChatRoom";

export class ChatService {
    private app: express.Express;
    private logger: winston.Logger;
    private profanity: Profanity;
    private prisma: PrismaClient;
    private connectingUsers: { [id: string]: IClientData } = {}
    private connections: { [id: string]: Client } = {}
    private connectionsByName: { [name: string]: Client } = {}
    private connectionsByGroupId: { [groupId: string]: { [id: string]: Client } } = {}

    constructor(app: express.Express, logger: winston.Logger, profanity: Profanity) {
        this.app = app;
        this.logger = logger;
        this.profanity = profanity;
        this.prisma = new PrismaClient();
        this.setupRoutes();
    }

    setupRoutes() {
        const app = this.app;
        const prisma = this.prisma;
        const connectingUsers = this.connectingUsers;
        const validateSystem = this.validateSystem;

        app.post('/chat/add-user', validateSystem, async (req, res, next) => {
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

        app.post('/chat/remove-user', validateSystem, async (req, res, next) => {
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
            } as IGroupLeaveResp)
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
            } as IGroupInvitationListResp)
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
            } as IGroupUserListResp)
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
            } as IGroupListResp)
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
                groupId: groupId,
                userId: targetClient.userData.userId,
                name: targetClient.userData.name,
            } as IGroupJoinResp)
        }
        await NotifyGroupInvitation(userId)
        await NotifyGroup(userId)
    }

    public onCreateRoom(room: ChatRoom) {
        const logger = this.logger;
        const profanity = this.profanity;
        const prisma = this.prisma
        const connectingUsers = this.connectingUsers;
        const connections = this.connections;
        const connectionsByName = this.connectionsByName;
        const connectionsByGroupId = this.connectionsByGroupId;
        const AddUserToGroup = this.AddUserToGroup;
        const NotifyGroup = this.NotifyGroup;
        const NotifyGroupInvitation = this.NotifyGroupInvitation;
        const NotifyGroupUser = this.NotifyGroupUser;
        const GroupLeave = this.GroupLeave;

        room.onMessage("validate-user", async (client, data) => {
            const userId = data.userId
            logger.info("[chat] Connecting by [" + client.id + "] user ID [" + userId + "]")
            if (!userId) {
                client.leave()
                logger.info("[chat] Not allow [" + client.id + "] to connect because it has invalid user ID")
                return
            }
            // If the client is not allowed, disconnect
            if (!Object.prototype.hasOwnProperty.call(connectingUsers, userId)) {
                client.leave()
                logger.info("[chat] Not allow [" + client.id + "] to connect because it has invalid user ID")
                return
            }

            // Validate connection key
            const connectingUser = connectingUsers[userId]
            const connectionKey = data.connectionKey
            if (connectionKey != connectingUser.connectionKey) {
                client.leave()
                logger.info("[chat] Not allow [" + client.id + "] to connect because it has invalid connection key")
                return
            }

            // Disconnect older socket
            if (Object.prototype.hasOwnProperty.call(connections, userId)) {
                connections[userId].leave()
                logger.info("[chat] Disconnect [" + connections[userId].id + "] because it is going to connect by newer client with the same user ID")
            }

            // Set user data after connected
            client.userData = connectingUser

            // Set socket client to the collections
            connections[userId] = client
            connectionsByName[connectingUser.name] = client

            // Find and store user groups
            const userGroups = await prisma.userGroup.findMany({
                where: {
                    userId: userId
                }
            })
            userGroups.forEach(userGroup => {
                if (!Object.prototype.hasOwnProperty.call(connectionsByGroupId, userGroup.groupId)) {
                    connectionsByGroupId[userGroup.groupId] = {}
                }
                connectionsByGroupId[userGroup.groupId][userId] = client
            })
            await NotifyGroup(userId)
        })

        room.onMessage("local", (client, data) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            for (const targetUserId in connections) {
                const targetClient = connections[targetUserId]
                targetClient.send("local", {
                    userId: userId,
                    name: client.userData.name,
                    msg: profanity.censor(data.msg),
                    map: data.map,
                    x: data.x,
                    y: data.y,
                    z: data.z,
                } as IChatResp)
            }
        })

        room.onMessage("global", (client, data) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            for (const targetUserId in connections) {
                const targetClient = connections[targetUserId]
                targetClient.send("global", {
                    userId: userId,
                    name: client.userData.name,
                    msg: profanity.censor(data.msg),
                } as IChatResp)
            }
        })

        room.onMessage("whisper", (client, data) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            const targetName = data.targetName
            if (!Object.prototype.hasOwnProperty.call(connectionsByName, targetName)) {
                return
            }
            const targetClient = connectionsByName[targetName]
            targetClient.send("whisper", {
                userId: userId,
                userId2: targetClient.userData.userId,
                name: client.userData.name,
                name2: targetClient.userData.name,
                msg: profanity.censor(data.msg),
            } as IChatResp)
            client.send("whisper", {
                userId: userId,
                userId2: targetClient.userData.userId,
                name: client.userData.name,
                name2: targetClient.userData.name,
                msg: profanity.censor(data.msg),
            } as IChatResp)
        })

        room.onMessage("whisper-by-id", (client, data) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            const targetUserId = data.targetUserId
            if (!Object.prototype.hasOwnProperty.call(connections, targetUserId)) {
                return
            }
            const targetClient = connections[targetUserId]
            targetClient.send("whisper", {
                userId: userId,
                userId2: targetClient.userData.userId,
                name: client.userData.name,
                name2: targetClient.userData.name,
                msg: profanity.censor(data.msg),
            } as IChatResp)
            client.send("whisper", {
                userId: userId,
                userId2: targetClient.userData.userId,
                name: client.userData.name,
                name2: targetClient.userData.name,
                msg: profanity.censor(data.msg),
            } as IChatResp)
        })

        room.onMessage("group", (client, data) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            const groupId = data.groupId
            if (!groupId) {
                return
            }
            // Has the group?
            if (!Object.prototype.hasOwnProperty.call(connectionsByGroupId, groupId)) {
                return
            }
            // User is in the group?
            if (!Object.prototype.hasOwnProperty.call(connectionsByGroupId[groupId], userId)) {
                return
            }
            const targetClients = connectionsByGroupId[groupId]
            for (const targetUserId in targetClients) {
                const targetClient = targetClients[targetUserId]
                targetClient.send("group", {
                    groupId: groupId,
                    userId: userId,
                    name: client.userData.name,
                    msg: profanity.censor(data.msg),
                } as IChatResp)
            }
        })

        room.onMessage("create-group", async (client, data) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            const groupId = nanoid(8)
            const title = data.title
            const iconUrl = data.iconUrl
            // Insert group data to database
            await prisma.group.create({
                data: {
                    groupId: groupId,
                    title: title,
                    iconUrl: iconUrl,
                }
            })
            // Add user to the group
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
            connectionsByGroupId[groupId] = {}
            connectionsByGroupId[groupId][userId] = client
            // Tell the client that the group was created
            client.send("create-group", {
                groupId: groupId,
                title: title,
                iconUrl: iconUrl,
            } as Group)
        })

        room.onMessage("update-group", async (client, data) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            const groupId = data.groupId
            if (!groupId) {
                return
            }
            // Has the group?
            if (!Object.prototype.hasOwnProperty.call(connectionsByGroupId, groupId)) {
                return
            }
            // User is in the group?
            if (!Object.prototype.hasOwnProperty.call(connectionsByGroupId[groupId], userId)) {
                return
            }
            // Update group data at database
            const title = data.title
            const iconUrl = data.iconUrl
            await prisma.group.update({
                where: {
                    groupId: groupId,
                },
                data: {
                    title: title,
                    iconUrl: iconUrl
                },
            })
            // Tell the clients that the group was updated
            const targetClients = connectionsByGroupId[groupId]
            for (const targetUserId in targetClients) {
                const targetClient = targetClients[targetUserId]
                targetClient.send("update-group", {
                    groupId: groupId,
                    title: title,
                    iconUrl: iconUrl,
                } as Group)
            }
        })

        room.onMessage("group-invitation-list", async (client, data) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            await NotifyGroupInvitation(userId)
        })

        room.onMessage("group-user-list", async (client, data) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            const groupId = data.groupId
            if (!groupId) {
                return
            }
            await NotifyGroupUser(userId, groupId)
        })

        room.onMessage("group-list", async (client, data) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            await NotifyGroup(userId)
        })

        room.onMessage("group-invite", async (client, data) => {
            const inviteId = client.userData.userId
            if (!inviteId) {
                return
            }
            const userId = data.userId
            if (!userId) {
                return
            }
            const groupId = data.groupId
            if (!groupId) {
                return
            }
            // Has the group?
            if (!Object.prototype.hasOwnProperty.call(connectionsByGroupId, groupId)) {
                return
            }
            // Inviter is in the group?
            if (!Object.prototype.hasOwnProperty.call(connectionsByGroupId[groupId], inviteId)) {
                return
            }
            let mode: Number = 0
            if (process.env.GROUP_USER_ADD_MODE) {
                mode = Number(process.env.GROUP_USER_ADD_MODE)
            }
            if (mode == 0) {
                // Create invitation
                await prisma.userGroupInvitation.deleteMany({
                    where: {
                        userId: userId,
                        groupId: groupId,
                    }
                })
                await prisma.userGroupInvitation.create({
                    data: {
                        userId: userId,
                        groupId: groupId,
                    }
                })
                await NotifyGroupInvitation(userId)
            } else {
                await AddUserToGroup(userId, groupId)
            }
        })

        room.onMessage("group-invite-accept", async (client, data) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            const groupId = data.groupId
            if (!groupId) {
                return
            }
            // Validate invitation
            const countInvitation = await prisma.userGroupInvitation.count({
                where: {
                    userId: userId,
                    groupId: groupId,
                }
            })
            if (countInvitation == 0) {
                return
            }
            // Delete invitation
            await prisma.userGroupInvitation.deleteMany({
                where: {
                    userId: userId,
                    groupId: groupId,
                }
            })
            // Add user to the group
            AddUserToGroup(userId, groupId)
        })

        room.onMessage("group-invite-decline", async (client, data) => {
            const userId = client.userData.userId
            if (!userId) {
                return
            }
            const groupId = data.groupId
            if (!groupId) {
                return
            }
            // Validate invitation
            const countInvitation = await prisma.userGroupInvitation.count({
                where: {
                    userId: userId,
                    groupId: groupId,
                }
            })
            if (countInvitation == 0) {
                return
            }
            // Delete invitation
            await prisma.userGroupInvitation.deleteMany({
                where: {
                    userId: userId,
                    groupId: groupId,
                }
            })
            await NotifyGroupInvitation(userId)
        })

        room.onMessage("leave-group", (client, data) => {
            const groupId = data.groupId
            GroupLeave(groupId, client.userData.userId)
        })

        room.onMessage("kick-user", (client, data) => {
            const groupId = data.groupId
            GroupLeave(groupId, data.userId)
        })
    }
}

interface IClientData {
    userId: string;
    name: string;
    connectionKey: string;
}

interface IGroupLeaveResp {
    groupId: string;
}

interface IGroupInvitationListResp {
    list: Group[];
}

interface IGroupUserListResp {
    groupId: string;
    list: User[];
}

interface IGroupListResp {
    list: Group[];
}

interface IGroupJoinResp {
    groupId: string;
    userId: string;
    name: string;
}

interface IChatResp {
    groupId?: string;
    userId: string;
    userId2?: string;
    name: string;
    name2?: string
    msg: string;
    map?: string;
    x?: number;
    y?: number;
    z?: number;
}