// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IEvidenceAnchor.sol";

/**
 * @title EvidenceAnchor
 * @notice Tamper-evident anchoring contract for Digital Evidence Metadata & Custody Events
 */
contract EvidenceAnchor is AccessControl, IEvidenceAnchor {
    bytes32 public constant ANCHOR_WRITER_ROLE = keccak256("ANCHOR_WRITER_ROLE");

    mapping(bytes32 => EvidenceRecord) private _evidenceRecords;
    mapping(bytes32 => CustodyRecord) private _custodyRecords;

    // Custom Errors for Gas Efficiency and Clear Reverts
    error EvidenceAlreadyExists(bytes32 evidenceKey);
    error EvidenceNotFound(bytes32 evidenceKey);
    error CustodyEventAlreadyExists(bytes32 eventKey);
    error InvalidEvidenceKey();
    error InvalidEvidenceHash();
    error InvalidEventKey();
    error InvalidEventHash();

    constructor(address admin, address writer) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ANCHOR_WRITER_ROLE, writer);
    }

    function registerEvidence(bytes32 evidenceKey, bytes32 evidenceHash) external override onlyRole(ANCHOR_WRITER_ROLE) {
        if (evidenceKey == bytes32(0)) revert InvalidEvidenceKey();
        if (evidenceHash == bytes32(0)) revert InvalidEvidenceHash();
        if (_evidenceRecords[evidenceKey].exists) revert EvidenceAlreadyExists(evidenceKey);

        _evidenceRecords[evidenceKey] = EvidenceRecord({
            evidenceKey: evidenceKey,
            evidenceHash: evidenceHash,
            timestamp: block.timestamp,
            exists: true
        });

        emit EvidenceAnchored(evidenceKey, evidenceHash, block.timestamp);
    }

    function anchorCustodyEvent(
        bytes32 evidenceKey,
        bytes32 eventKey,
        bytes32 eventHash,
        uint8 action
    ) external override onlyRole(ANCHOR_WRITER_ROLE) {
        if (evidenceKey == bytes32(0)) revert InvalidEvidenceKey();
        if (eventKey == bytes32(0)) revert InvalidEventKey();
        if (eventHash == bytes32(0)) revert InvalidEventHash();
        if (!_evidenceRecords[evidenceKey].exists) revert EvidenceNotFound(evidenceKey);
        if (_custodyRecords[eventKey].exists) revert CustodyEventAlreadyExists(eventKey);

        _custodyRecords[eventKey] = CustodyRecord({
            eventKey: eventKey,
            evidenceKey: evidenceKey,
            eventHash: eventHash,
            action: action,
            timestamp: block.timestamp,
            exists: true
        });

        emit CustodyEventAnchored(evidenceKey, eventKey, eventHash, action, block.timestamp);
    }

    function verifyEvidenceHash(bytes32 evidenceKey, bytes32 evidenceHash) external view override returns (bool) {
        if (!_evidenceRecords[evidenceKey].exists) return false;
        return _evidenceRecords[evidenceKey].evidenceHash == evidenceHash;
    }

    function getEvidenceRecord(bytes32 evidenceKey) external view override returns (bytes32, bytes32, uint256, bool) {
        EvidenceRecord memory record = _evidenceRecords[evidenceKey];
        if (!record.exists) revert EvidenceNotFound(evidenceKey);
        return (record.evidenceKey, record.evidenceHash, record.timestamp, record.exists);
    }

    function getCustodyRecord(bytes32 eventKey) external view override returns (bytes32, bytes32, bytes32, uint8, uint256, bool) {
        CustodyRecord memory record = _custodyRecords[eventKey];
        if (!record.exists) revert("Custody event not found");
        return (record.eventKey, record.evidenceKey, record.eventHash, record.action, record.timestamp, record.exists);
    }
}