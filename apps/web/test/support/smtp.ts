import { once } from "node:events";
import { createServer, type Socket } from "node:net";

export async function openSmtpInbox(
  outcome: (message: string) => "sent" | "failed" | "unknown" = () => "sent",
) {
  const messages: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 relay.example ESMTP\r\n");
    let buffer = "",
      data = false,
      message = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") {
            messages.push(message);
            const result = outcome(message);
            message = "";
            data = false;
            if (result === "unknown") socket.destroy();
            else
              socket.write(
                result === "failed" ? "550 mailbox refused message\r\n" : "250 accepted\r\n",
              );
          } else message += `${line}\n`;
        } else if (line.startsWith("EHLO") || line.startsWith("HELO"))
          socket.write("250 relay.example\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 send message\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No SMTP port was bound");
  return {
    url: `smtp://127.0.0.1:${String(address.port)}`,
    messages,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
}
