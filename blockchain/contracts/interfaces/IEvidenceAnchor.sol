// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IEvidenceAnchor {
    struct EvidenceRecord {
        bytes32 evidenceKey;
        bytes32 evidenceHash;
        uint256 timestamp;
        bool exists;
    }

    struct CustodyRecord {
        bytes32 eventKey;
        bytes32 evidenceKey;
        bytes32 eventHash;
        uint8 action;
        uint256 timestamp;
        bool exists;
    }

    event EvidenceAnchored(bytes32 indexed evidenceKey, bytes32 evidenceHash, uint256 timestamp);
    event CustodyEventAnchored(bytes32 indexed evidenceKey, bytes32 indexed eventKey, bytes32 eventHash, uint8 action, uint256 timestamp);

    function registerEvidence(bytes32 evidenceKey, bytes32 evidenceHash) external;
    function anchorCustodyEvent(bytes32 evidenceKey, bytes32 eventKey, bytes32 eventHash, uint8 action) external;
    function verifyEvidenceHash(bytes32 evidenceKey, bytes32 evidenceHash) external view returns (bool);
    function getEvidenceRecord(bytes32 evidenceKey) external view returns (bytes32, bytes32, uint256, bool);
    function getCustodyRecord(bytes32 eventKey) external view returns (bytes32, bytes32, bytes32, uint8, uint256, bool);
}