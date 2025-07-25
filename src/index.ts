import express from 'express';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

dotenv.config();

interface UserPayload {
  id: string;
  role: 'WAITER' | 'KITCHEN' | 'ADMIN';
  adminId: string;
}

interface AuthenticatedWebSocket extends WebSocket {
  user?: UserPayload;
  isAlive?: boolean;
}

const app = express();
app.use(express.json());


const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.SECRETKEY_JWT;


if (!JWT_SECRET) {
  console.error("FATAL ERROR: SECRETKEY_JWT is not defined in the environment variables.");
  process.exit(1);
}


const httpServer = app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📡 WebSocket server is ready`);
});

const wss = new WebSocketServer({ server: httpServer });


// Health check: ping/pong to detect broken clients
setInterval(() => {
  wss.clients.forEach((ws) => {
    const client = ws as AuthenticatedWebSocket;
    if (client.isAlive === false) {
      console.log(`⚠️ Terminating stale connection`);
      return client.terminate();
    }
    client.isAlive = false;
    client.ping();
  });
}, 30000);


wss.on('connection', function connection(ws: WebSocket, req) {
  const authWs = ws as AuthenticatedWebSocket;
  authWs.isAlive = true;

  ws.on('pong', () => {
    authWs.isAlive = true;  
  });

  try {
    // 1. Parse token from query string using modern URL
    const parsedUrl = new URL(req.url ?? '', `http://${req.headers.host}`);
    const token = parsedUrl.searchParams.get('token');

    if (!token) {
      throw new Error('Authentication failed: No token provided.');
    }
    console.log(token)

    const payload = jwt.verify(token, JWT_SECRET) as UserPayload;

    // 2. Validate payload structure
    if (!payload.id || !payload.role || !payload.adminId) {
      throw new Error('Authentication failed: Invalid token payload.');
    }

    authWs.user = payload;

    console.log(`✅ Client connected: UserID ${authWs.user.id}, Role ${authWs.user.role}, AdminID ${authWs.user.adminId}`);

    authWs.on('error', console.error);

    authWs.on('message', function message(data) {
      // Ignore messages from non-waiters
      if (authWs.user?.role !== 'WAITER') return;

      let orderData;
      try {
        orderData = JSON.parse(data.toString());
      } catch (e) {
        console.error(`❗ Invalid message from ${authWs.user.id}:`, e);
        authWs.send(JSON.stringify({ type: 'ERROR', message: 'Invalid message format. Expected JSON.' }));
        return;
      }

      console.log(`📬 Order from Waiter ${authWs.user.id} (Admin ${authWs.user.adminId}):`, orderData);

      const payloadForKitchen = JSON.stringify({
        ...orderData,
        waiterId: authWs.user.id,
      });

      // Broadcast to relevant KITCHEN clients
      wss.clients.forEach(function each(client) {
        const kitchenWs = client as AuthenticatedWebSocket;
        if (
          kitchenWs !== authWs &&
          kitchenWs.readyState === WebSocket.OPEN &&
          kitchenWs.user?.role === 'KITCHEN' &&
          kitchenWs.user.adminId === authWs.user?.adminId
        ) {
          console.log(`  -> Relaying to Kitchen staff ${kitchenWs.user.id}`);
          kitchenWs.send(payloadForKitchen);
        }
      });
    });

    authWs.on('close', () => {
      if (authWs.user) {
        console.log(`❌ Client disconnected: UserID ${authWs.user.id}`);
      } else {
        console.log(`❌ Unauthenticated client disconnected.`);
      }
    });

  } catch (error) {
    if (error instanceof Error) {
      console.error(`Authentication error: ${error.message}`);
    } else {
      console.error(`Authentication error: ${String(error)}`);
    }
    ws.terminate();
  }
});
