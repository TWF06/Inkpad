import UIKit
import Capacitor

/// The app's web view. Registers Inkpad's own native plugin (the notes folder, sharing, printing).
class InkpadViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NotesFolderPlugin())
    }
}
