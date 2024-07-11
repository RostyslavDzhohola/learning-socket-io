import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "socket.io";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { availableParallelism } from "node:os";
import cluster from "node:cluster";
import { createAdapter, setupPrimary } from "@socket.io/cluster-adapter";

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      PORT: 3000 + i,
    });
  }

  setupPrimary();
} else {
  const db = await open({
    filename: "chat.db",
    driver: sqlite3.Database,
  });

  // todo: modify db to include senderUserName
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_user_name TEXT,
      content TEXT,
      client_offset TEXT UNIQUE
    );
  `);

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
    adapter: createAdapter(),
  });
  const __dirname = dirname(fileURLToPath(import.meta.url));

  app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "index.html"));
  });

  io.on("connection", async (socket) => {
    console.log(
      `New connection: ${socket.id}, Username: ${socket.handshake.auth.userName}`
    );
    async function getUsersOnline() {
      const sockets = await io.fetchSockets();
      let usersOnline = new Set();

      sockets.forEach((socket) => {
        usersOnline.add(socket.handshake.auth.userName);
      });
      // console.log(`Users: ${[...usersOnline]}`);
      return usersOnline;
    }

    async function getUserSocketMap() {
      const sockets = await io.fetchSockets();
      let userSocketMap = new Map(
        sockets.map((socket) => [socket.handshake.auth.userName, socket.id])
      );
      // console.log('userSocketMap:', userSocketMap.size, 'and value for', socket.handshake.auth.userName, 'is', userSocketMap.get(socket.handshake.auth.userName)); // log the userSocketMap
      return userSocketMap;
    }

    socket.on("private message", async ({ toUserName, privateMsg }) => {
      console.log(
        `Event private message from ${socket.handshake.auth.userName} to ${toUserName}: ${privateMsg}`
      ); // log the event

      const userSocketMap = await getUserSocketMap();
      const toSocketId = userSocketMap.get(toUserName);

      console.log(`Mapped socket ID for ${toUserName} is ${toSocketId}`); // log the mapped socket ID

      const allSockets = await io.fetchSockets();

      console.log(`All sockets: ${allSockets.map((socket) => socket.id)}`); // log all sockets

      const toSocket = io.sockets.sockets.get(toSocketId);

      if (toSocket) {
        console.log(`Found socket for ${toUserName} with ID: ${toSocket.id}`); // log the found socket
        io.to(toSocketId).emit("private message", {
          fromUser: socket.handshake.auth.userName,
          message: privateMsg,
        });
        console.log(
          `Emitted private message to ${toUserName} with socket ID ${toSocketId}`
        ); // log the emitted private message
      } else {
        console.log(
          `Socket for ${toUserName} not found. Mapped ID was ${toSocketId}`
        ); // log the socket not found
        // Attempt to find the correct socket
        const correctSocket = allSockets.find(
          (s) => s.handshake.auth.userName === toUserName
        );
        if (correctSocket) {
          console.log(
            `Found correct socket for ${toUserName} with ID: ${correctSocket.id}`
          );
          io.to(correctSocket.id).emit("private message", {
            fromUser: socket.handshake.auth.userName,
            message: privateMsg,
          });
          console.log(
            `Emitted private message to ${toUserName} using corrected socket ID`
          ); // log the emitted private message using corrected socket ID
        } else {
          console.log(`No socket found for ${toUserName}`); // log the no socket found
        }
      }
    });

    socket.on("chat message", async (msg, clientOffset, callback) => {
      let result;
      try {
        result = await db.run(
          "INSERT INTO messages (sender_user_name, content, client_offset) VALUES (?, ?, ?)",
          socket.handshake.auth.userName,
          msg,
          clientOffset
        );
      } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
          callback();
        } else {
          // nothing to do, just let the client retry
        }
        return;
      }
      socket.broadcast.volatile.emit(
        "user typing",
        socket.handshake.auth.userName,
        false
      );
      socket.broadcast.emit(
        "chat message",
        socket.handshake.auth.userName,
        msg,
        result.lastID
      );
      callback();
    });

    if (!socket.recovered) {
      try {
        console.log(
          `recovering ${socket.id} with name ${socket.handshake.auth.userName}`
        );
        const usersOnline = await getUsersOnline();
        // const userSocketMap = await getUserSocketMap();
        // console.log(`Array of users when recovered ${Array.from(usersOnline)} and size is ${usersOnline.size}`);
        io.emit(
          "user connected",
          socket.handshake.auth.userName,
          Array.from(usersOnline)
        );
        await db.each(
          "SELECT id, sender_user_name, content FROM messages WHERE id > ?",
          [socket.handshake.auth.serverOffset || 0],
          (_err, row) => {
            socket.emit(
              "chat message",
              row.sender_user_name,
              row.content,
              row.id
            );
          }
        );
      } catch (e) {
        // something went wrong
      }
    }

    socket.on("user typing", (userName, status) => {
      socket.broadcast.volatile.emit("user typing", userName, status);
    });

    socket.on("disconnect", async (reason) => {
      console.log(
        `disconnected ${socket.id} with username ${socket.handshake.auth.userName} due to ${reason}`
      );
      const usersOnline = await getUsersOnline();
      const userSocketMap = await getUserSocketMap();
      // console.log(
      //   `Array of users when disconnected ${Array.from(usersOnline)}`
      // );
      usersOnline.delete(socket.handshake.auth.userName);
      userSocketMap.delete(socket.handshake.auth.userName);
      // console.log(`Users: ${[...usersOnline]}`);
      io.emit(
        "user disconnected",
        socket.handshake.auth.userName,
        Array.from(usersOnline)
      );
    });

    socket.onAny((eventName, ...args) => {
      console.log(`Received event: ${eventName}`, args);
    });
  });

  const port = process.env.PORT;

  server.listen(port, () => {
    console.log(`server running at http://localhost:${port}`);
  });
}
