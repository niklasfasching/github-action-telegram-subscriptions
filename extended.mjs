export function extendNotifier(Notifier) {
  return class extends Notifier {
    constructor(file, token) {
      super(file, token);
    }
  };
}
