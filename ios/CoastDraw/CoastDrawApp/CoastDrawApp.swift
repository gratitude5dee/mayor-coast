import SwiftUI

@main
struct CoastDrawApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 16) {
                Image(systemName: "scribble.variable")
                    .font(.system(size: 54, weight: .bold))
                    .foregroundStyle(Color(red: 0.96, green: 0.71, blue: 0.27))
                Text("COAST Draw")
                    .font(.largeTitle.bold())
                Text("Open Messages, tap +, and choose COAST Draw. A /draw card opens the canvas in its conversation.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            .padding(28)
        }
    }
}
