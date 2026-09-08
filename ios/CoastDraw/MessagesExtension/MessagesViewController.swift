import Messages
import SwiftUI

final class MessagesViewController: MSMessagesAppViewController {
    private let model = DrawSessionModel()
    private var host: UIHostingController<DrawView>?

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: DrawView(model: model))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
        self.host = host
    }

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        Task { await model.open(messageURL: conversation.selectedMessage?.url) }
        if presentationStyle == .compact { requestPresentationStyle(.expanded) }
    }

    override func didSelect(_ message: MSMessage, conversation: MSConversation) {
        super.didSelect(message, conversation: conversation)
        Task { await model.open(messageURL: message.url) }
    }

    override func didResignActive(with conversation: MSConversation) {
        model.pause()
        super.didResignActive(with: conversation)
    }

    override func contentSizeThatFits(_ size: CGSize) -> CGSize {
        guard presentationStyle == .transcript else { return size }
        return CGSize(width: min(size.width, 360), height: min(size.height, 440))
    }
}
