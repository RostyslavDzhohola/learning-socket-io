// server side
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter';

if(cluster.isPrimary) {
  const numCPUs = availableParallelism();
  // create one worker per available core
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      PORT:3000 + i
    });
  }
  // set up the adapter on the primary thread
  setupPrimary();
} else {
  const db = await open({
    filename: 'chat.db', 
    driver: sqlite3.Database
  })
  
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
    // set up the adapter on each worker thread
    adapter: createAdapter()
  });

  const __dirname = dirname(fileURLToPath(import.meta.url));

  // Define a route for the root URL ('/')
  app.get('/', (req, res) => {
    // Send the 'index.html' file as the response
    // __dirname is the directory of the current module
    // join() is used to create a proper file path
    res.sendFile(join(__dirname, 'index.html'));
  });

  io.on('connection', async (socket) => {

    socket.on('chat message', async (msg, clientOffset, callback) => {
      console.log('Received message:', msg);
      console.log('Client offset:', clientOffset);
      console.log('Callback type:', typeof callback);

      // Ensure msg and clientOffset are strings
      if (typeof msg !== 'string' || typeof clientOffset !== 'string') {
        console.error('Invalid message or clientOffset');
        return;
      }

      let result;
      try {
        result = await db.run('INSERT INTO messages (content, client_offset) VALUES (?, ?)', msg, clientOffset);
      } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */ ) {
          if (typeof callback === 'function') callback();
        } else {
          console.error('Database error:', e);
        }
        return;
      }
      console.log('message: ' + msg );
      io.emit('chat message', msg, result.lastID);
      if (typeof callback === 'function') callback();
    });


    //sending back missing messages on reconnection
    if (!socket.recovered) {
      try {
        await db.each('SELECT id, content FROM messages WHERE id > ?',
          [socket.handshake.auth.serverOffset || 0],
          (_err, row) => {
            socket.emit('chat message', row.content, row.id);
          }
        )
      } catch (e) {
        //handle error
        console.log (e);
      }
      
    }

    socket.on('nickname connected', (nickname) => {
      console.log(`User ${nickname} connected`);
      socket.nickname = nickname; // Store the nickname on the socket object
      socket.broadcast.emit('user connected', nickname);
    });

    socket.on('disconnect', () => {
      if (socket.nickname) {
        console.log(`User ${socket.nickname} disconnected`);
        socket.broadcast.emit('user disconnected', socket.nickname);
      }
    });
  });

  const port = process.env.PORT;

  server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}


