// server side
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

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
  connectionStateRecovery: {}
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
  console.log("a user connected"  );

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

  socket.on('disconnect', () => {
    console.log("user disconnected");
  });
});

server.listen(3000, () => {
  console.log('server running at http://localhost:3000');
});