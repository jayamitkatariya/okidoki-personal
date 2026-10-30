import CommonCrypto
import CryptoKit
import Foundation

/// The same sealing the control panel does (`web/src/vaultCrypto.ts`): AES-GCM with a key derived
/// from the vault passphrase by PBKDF2-SHA256, salted with the vault's own id. The Mac only opens a
/// login when the person chose "remember on this Mac", for the browser to fill a page or a replay to
/// sign in; the opened secret is never written anywhere.
public enum VaultCrypto {
    static let iterations: UInt32 = 200_000

    public static func key(passphrase: String, vaultID: String) -> SymmetricKey? {
        let password = Array(passphrase.precomposedStringWithCompatibilityMapping.utf8)
        let salt = Array("okidoki-vault:\(vaultID)".utf8)
        var derived = [UInt8](repeating: 0, count: 32)
        let status = password.withUnsafeBufferPointer { pw in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                 UnsafeRawPointer(pw.baseAddress!).assumingMemoryBound(to: Int8.self), pw.count,
                                 salt, salt.count,
                                 CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), iterations,
                                 &derived, derived.count)
        }
        return status == kCCSuccess ? SymmetricKey(data: derived) : nil
    }

    /// Nil when the passphrase is wrong or the sealed box was changed.
    public static func open(ciphertext: String, iv: String, key: SymmetricKey) -> String? {
        // WebCrypto puts the 16-byte tag at the end of the ciphertext.
        guard let sealed = Data(base64Encoded: ciphertext), let nonceData = Data(base64Encoded: iv),
              sealed.count > 16, let nonce = try? AES.GCM.Nonce(data: nonceData),
              let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: sealed.dropLast(16), tag: sealed.suffix(16)),
              let plain = try? AES.GCM.open(box, using: key) else { return nil }
        return String(data: plain, encoding: .utf8)
    }

    /// Seals the way the panel does, for tests and for logins the Mac saves itself.
    public static func seal(_ secret: String, key: SymmetricKey) -> (ciphertext: String, iv: String)? {
        guard let box = try? AES.GCM.seal(Data(secret.utf8), using: key) else { return nil }
        return ((box.ciphertext + box.tag).base64EncodedString(), Data(box.nonce).base64EncodedString())
    }
}
