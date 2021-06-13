export async function updateSubscription(chatID, subscription, telegram) {
  telegram.sendMessage(chatID, "update");
}
