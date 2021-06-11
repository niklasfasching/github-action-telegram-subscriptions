import {webcrypto} from "crypto";
import * as fs from "fs";
import {request} from "https";


// TODO: try catch each individual receive / send
// TODO: keep state - e.g. last message send, not just config

class Notifier {
  constructor(file, token) {
    this.db = new DB(file, token);
    this.telegram = new Telegram(token);
  }

  async notify() {
    const subscriptions = await this.db.read();
    await this.telegram.receiveUpdates((update) => this.onUpdate(subscriptions, update));
    await this.db.write(subscriptions);
    for (let [chatId, config] of Object.entries(subscriptions)) {
      await this.update(chatId, config, this.telegram);
    }
  }

  async onUpdate(subscriptions, update) {
    const message = update.message || update.edited_message;
    if (!message) return;
    else if (message.text === "/start") {
      subscriptions[message.chat.id] = {};
      await this.telegram.sendMessage(message.chat.id, "subscribed");
    } else if (message.text === "/stop") {
      delete subscriptions[message.chat.id];
      await this.telegram.sendMessage(message.chat.id, "unsubscribed");
    }
    else {
      try {
        subscriptions[message.chat_id] = JSON.parse(message.text);
        await this.telegram.sendMessage(message.chat.id, "subscribed");
      } catch (err) {
        await this.telegram.sendMessage(message.chat.id, "bad config (invalid json)");
      }
    }
  }

  async update(chatId, config, telegram) {
    this.telegram.sendMessage(chatId, "update");
  }
}


class Telegram {
  constructor(token) {
    this.offset = 0;
    this.token = token;
  }

  sendMessage(chatId, text) {
    return this.callAPI("sendMessage", {chat_id: chatId, text});
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


// https://github.com/mdn/dom-examples/blob/master/web-crypto/derive-key/pbkdf2.js
// https://github.com/mdn/dom-examples/blob/master/web-crypto/encrypt-decrypt/aes-gcm.js
// https://security.stackexchange.com/questions/177990/what-is-the-best-practice-to-store-private-key-salt-and-initialization-vector-i

class DB {
  constructor(file, password) {
    this.file = file;
    this.password = password;
  }

  async read() {
    if (!fs.existsSync(this.file)) return {};
    const plaintext = await this.decrypt(await fs.readFileSync(this.file), this.password);
    return JSON.parse(plaintext);
  }

  async write(object) {
    const ciphertext = await this.encrypt(JSON.stringify(object), this.password);
    fs.writeFileSync(this.file, ciphertext);
  }

  async encrypt(plaintext) {
    const keyMaterial = await this.getKeyMaterial(this.password);
    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const key = await this.getKey(keyMaterial, salt);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await webcrypto.subtle.encrypt(
      {name: "AES-GCM", iv: iv}, key,
      new TextEncoder().encode(plaintext),
    );
    return Uint8Array.of(...salt, ...iv, ...new Uint8Array(ciphertext));
  }

  async decrypt(ciphertext, password) {
    let keyMaterial = await this.getKeyMaterial(password);
    const salt = ciphertext.slice(0, 16);
    const iv = ciphertext.slice(16, 16 + 12);
    const key = await this.getKey(keyMaterial, salt);
    const decrypted = await webcrypto.subtle.decrypt({name: "AES-GCM", iv}, key, ciphertext.slice(16 + 12));
    return new TextDecoder().decode(decrypted);
  }

  getKeyMaterial(password) {
    return webcrypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      {name: "PBKDF2"},
      false,
      ["deriveBits", "deriveKey"],
    );
  }

  getKey(keyMaterial, salt) {
    return webcrypto.subtle.deriveKey(
      {name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256"},
      keyMaterial,
      {name: "AES-GCM", length: 256},
      true,
      [ "encrypt", "decrypt" ],
    );
  }
}


async function main() {
  const [extendingModule, file, token] = process.argv.slice(2);
  let NotifierClass = extendingModule ?
      (await import(extendingModule)).extendNotifier(Notifier) :
      Notifier;
  let n = new NotifierClass(file, token);
  await n.notify();
}

main();
