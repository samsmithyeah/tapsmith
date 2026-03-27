import Foundation

/// Structured error types matching the Android agent's error protocol.
/// These map to the JSON error types sent back to the daemon.
enum AgentError: Error {
    case elementNotFound(String)
    case timeout(String)
    case invalidSelector(String)
    case actionFailed(String)
    case parseError(String)
    case invalidRequest(String)
    case internalError(String)

    var type: String {
        switch self {
        case .elementNotFound: return "ELEMENT_NOT_FOUND"
        case .timeout: return "TIMEOUT"
        case .invalidSelector: return "INVALID_SELECTOR"
        case .actionFailed: return "ACTION_FAILED"
        case .parseError: return "PARSE_ERROR"
        case .invalidRequest: return "INVALID_REQUEST"
        case .internalError: return "INTERNAL_ERROR"
        }
    }

    var message: String {
        switch self {
        case .elementNotFound(let msg),
             .timeout(let msg),
             .invalidSelector(let msg),
             .actionFailed(let msg),
             .parseError(let msg),
             .invalidRequest(let msg),
             .internalError(let msg):
            return msg
        }
    }
}
