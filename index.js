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

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT
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

    async function getUsersOnline() {
      const sockets = await io.fetchSockets();
      let usersOnline = new Set();
      sockets.forEach((socket) => {
        usersOnline.add(socket.handshake.auth.userName);
      });
      console.log(`Users: ${[...usersOnline]}`);
      return usersOnline;
    }

    socket.on("chat message", async (msg, clientOffset, callback) => {
      let result;
      let msgWithName = `${socket.handshake.auth.userName}: ${msg}`;
      try {
        result = await db.run(
          "INSERT INTO messages (content, client_offset) VALUES (?, ?)",
          msgWithName,
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
      socket.broadcast.emit("chat message", msgWithName, result.lastID);
      callback();
    });

    if (!socket.recovered) {
      try {
        console.log(`recovering ${socket.id} with name ${socket.handshake.auth.userName}`);
        const usersOnline = await getUsersOnline();
        console.log(`Array of users when recovered ${Array.from(usersOnline)}`);
        io.emit("user connected", socket.handshake.auth.userName, Array.from(usersOnline));
        await db.each(
          "SELECT id, content FROM messages WHERE id > ?",
          [socket.handshake.auth.serverOffset || 0],
          (_err, row) => {
            socket.emit("chat message", row.content, row.id);
          }
        );
      } catch (e) {
        // something went wrong
      }
    }

    socket.on('user typing', (userName, status) => {
      socket.broadcast.volatile.emit('user typing', userName, status);
    });

    socket.on("disconnect", async (reason) => {
      console.log(`disconnected ${socket.id} with username ${socket.handshake.auth.userName} due to ${reason}`);
      const usersOnline = await getUsersOnline();
      console.log(`Array of users when disconnected ${Array.from(usersOnline)}`);
      usersOnline.delete(socket.handshake.auth.userName);
      console.log(`Users: ${[...usersOnline]}`);
      io.emit("user disconnected", socket.handshake.auth.userName, Array.from(usersOnline));
    
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
