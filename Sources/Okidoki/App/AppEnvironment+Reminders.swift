import AppKit
import OkidokiCore
import UserNotifications

/// okidoki's own reminders: checked every few seconds, fired as a notification and a card in the
/// notch, with done and snooze right there. One that carries a skill replays it.
extension AppEnvironment {
    func startReminders() {
        reminderTimer?.invalidate()
        reminderTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.fireDueReminders() }
        }
        fireDueReminders()
    }

    func fireDueReminders(now: Date = Date()) {
        // Every account's: a reminder shouldn't wait for its account to be the one in front.
        for reminder in store.reminders where reminder.isDue(now: now) {
            store.markReminderFired(reminder.id, at: now)
            fire(reminder)
        }
    }

    private func fire(_ reminder: Reminder) {
        if let skillID = reminder.skillID, let skill = store.skill(skillID) {
            toast(title: "reminder · \(reminder.title)", detail: "replaying “\(skill.name)” now", kind: .info,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            replaySkill(skill)
            return
        }
        toast(title: "reminder", detail: reminder.title, kind: .info,
              undoLabel: "done", onUndo: { [weak self] in
                  self?.store.completeReminder(reminder.id)
                  self?.store.saveNow()
              },
              editLabel: "in 10 min", onEdit: { [weak self] in self?.snoozeReminder(reminder.id, minutes: 10) },
              runID: nil)
        speak("Reminder: \(reminder.title)")
        notify(title: "Reminder", body: reminder.title, id: reminder.id)
    }

    func snoozeReminder(_ id: String, minutes: Int) {
        guard var reminder = store.reminders.first(where: { $0.id == id }) else { return }
        reminder.dueAt = Date().addingTimeInterval(TimeInterval(minutes * 60))
        reminder.done = false
        store.updateReminder(reminder)
        store.saveNow()
    }

    /// A system notification too, so a reminder isn't missed while the notch is out of sight.
    private func notify(title: String, body: String, id: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            center.add(UNNotificationRequest(identifier: "reminder-\(id)-\(Int(Date().timeIntervalSince1970))", content: content, trigger: nil))
        }
    }
}
