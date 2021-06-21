import {execSync} from "child_process";
import * as fs from "fs";
import {request} from "https";
import * as path from "path";

// TODO: try catch each individual receive / send
// TODO: keep state - e.g. last message send, not just config

class Notifier {
  constructor(file, token, handler) {
    this.handler = handler;
    this.file = file;
    this.token = token;
    this.telegram = new Telegram(token);
  }

  async notify() {
    const subscriptions = this.read();
    await this.telegram.receiveUpdates((update) => this.onUpdate(subscriptions, update));
    for (let [chatId, subscription] of Object.entries(subscriptions)) {
      await this.handler.updateSubscription(chatId, subscription, this.telegram);
    }
    this.write(subscriptions);
  }

  async onUpdate(subscriptions, update) {
    const message = update.message || update.edited_message;
    if (!message) return;
    else if (message.text === "/start") {
      subscriptions[message.chat.id] = {config: {timestamp: Date.now()}, state: {}};
      await this.telegram.sendMessage(message.chat.id, "subscribed");
    } else if (message.text === "/stop") {
      delete subscriptions[message.chat.id];
      await this.telegram.sendMessage(message.chat.id, "unsubscribed");
    }
    else {
      try {
        const config = JSON.parse(message.text);
        subscriptions[message.chat_id] = {config: Object.assign(config, {timestamp: Date.now()}), state: {}};
        await this.telegram.sendMessage(message.chat.id, "subscribed with config");
      } catch (err) {
        await this.telegram.sendMessage(message.chat.id, "bad config (invalid json)");
      }
    }
  }

  read() {
    if (!fs.existsSync(this.file)) return {};
    const plaintext = execSync(`openssl enc -d -aes256 -pbkdf2 -pass env:PASSWORD -in "${this.file}"`, {
      env: {PASSWORD: this.token},
    });
    this.plaintext = plaintext.toString();
    return JSON.parse(plaintext);
  }

  write(object) {
    const plaintext = JSON.stringify(object, null, 2);
    if (this.plaintext === plaintext) return;
    return execSync(`openssl enc -aes256 -pbkdf2 -pass env:PASSWORD -out "${this.file}"`, {
      env: {PASSWORD: this.token},
      input: plaintext,
    });
  }
}


class Telegram {
  constructor(token) {
    this.offset = 0;
    this.token = token;
  }

  sendMessage(chatId, text) {
    return this.callAPI("sendMessage", {chat_id: chatId, text, parse_mode: "HTML"});
  }

  async receiveUpdates(onUpdate) {
    const updates = await this.callAPI("getUpdates", {offset: this.offset+1, timeout: 0});
    for (let update of updates) {
      this.offset = update.update_id;
      await onUpdate(update);
    }
    if (updates.length) await this.receiveUpdates(onUpdate);
  }

  callAPI(method, params = {}) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(params);
      const req = request({
        hostname: "api.telegram.org",
        path: `/bot${this.token}/${method}`,
        port: 443,
        method: "POST",
        headers: {"Content-Type": "application/json", "Content-Length": body.length},
      }, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            if (!result.ok) return void reject(new Error(`/${method} (${body}) => (${data})`));
            resolve(result.result);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", (err) => reject(err));
      req.write(body);
      req.end();
    });
  }
}

async function main() {
  const [file, token, module] = process.argv.slice(2);
  const m = await import(module.match(/^https?:/) ? module : path.resolve(process.cwd(), module));
  let n = new Notifier(file, token, m);
  await n.notify();
}

main();
