import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;
import { EvidenceAnchor } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("EvidenceAnchor", function () {
  let evidenceAnchor: EvidenceAnchor;
  let admin: SignerWithAddress;
  let writer: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  const ANCHOR_WRITER_ROLE = ethers.id("ANCHOR_WRITER_ROLE");
  const sampleEvidenceKey = ethers.id("EV-2026-001");
  const sampleEvidenceHash = ethers.id("hash-abc-123");
  const sampleEventKey = ethers.id("CUSTODY-001");
  const sampleEventHash = ethers.id("event-hash-xyz");
  const actionType = 1; // TRANSFER_ACCEPTED

  beforeEach(async function () {
    [admin, writer, unauthorized] = await ethers.getSigners();

    const EvidenceAnchorFactory = await ethers.getContractFactory("EvidenceAnchor");
    evidenceAnchor = (await EvidenceAnchorFactory.deploy(admin.address, writer.address)) as unknown as EvidenceAnchor;
    await evidenceAnchor.waitForDeployment();
  });

  describe("TEST GROUP 1 — DEPLOYMENT", function () {
    it("Should deploy successfully and configure roles correctly", async function () {
      expect(await evidenceAnchor.hasRole(ANCHOR_WRITER_ROLE, writer.address)).to.be.true;
      expect(await evidenceAnchor.hasRole(await evidenceAnchor.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
    });
  });

  describe("TEST GROUP 2 & 3 — EVIDENCE REGISTRATION", function () {
    it("Authorized writer can register valid evidence and emit event", async function () {
      await expect(evidenceAnchor.connect(writer).registerEvidence(sampleEvidenceKey, sampleEvidenceHash))
        .to.emit(evidenceAnchor, "EvidenceAnchored")
        .withArgs(sampleEvidenceKey, sampleEvidenceHash, anyValue);

      const record = await evidenceAnchor.getEvidenceRecord(sampleEvidenceKey);
      expect(record[0]).to.equal(sampleEvidenceKey);
      expect(record[1]).to.equal(sampleEvidenceHash);
      expect(record[3]).to.be.true;
    });

    it("Unauthorized user cannot register evidence", async function () {
      await expect(
        evidenceAnchor.connect(unauthorized).registerEvidence(sampleEvidenceKey, sampleEvidenceHash)
      ).to.be.reverted;
    });
  });

  describe("TEST GROUP 4 & 5 — DUPLICATE & INVALID EVIDENCE", function () {
    it("Should reject duplicate evidence registration (same key + same hash or different hash)", async function () {
      await evidenceAnchor.connect(writer).registerEvidence(sampleEvidenceKey, sampleEvidenceHash);

      // Attempt same key + same hash
      await expect(
        evidenceAnchor.connect(writer).registerEvidence(sampleEvidenceKey, sampleEvidenceHash)
      ).to.be.revertedWithCustomError(evidenceAnchor, "EvidenceAlreadyExists");

      // Attempt same key + different hash
      const diffHash = ethers.id("hash-diff");
      await expect(
        evidenceAnchor.connect(writer).registerEvidence(sampleEvidenceKey, diffHash)
      ).to.be.revertedWithCustomError(evidenceAnchor, "EvidenceAlreadyExists");
    });

    it("Should reject zero-value keys or hashes", async function () {
      await expect(
        evidenceAnchor.connect(writer).registerEvidence(ethers.ZeroHash, sampleEvidenceHash)
      ).to.be.revertedWithCustomError(evidenceAnchor, "InvalidEvidenceKey");

      await expect(
        evidenceAnchor.connect(writer).registerEvidence(sampleEvidenceKey, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(evidenceAnchor, "InvalidEvidenceHash");
    });
  });

  describe("TEST GROUP 6, 7 & 8 — CUSTODY EVENTS & REPLAY PROTECTION", function () {
    beforeEach(async function () {
      await evidenceAnchor.connect(writer).registerEvidence(sampleEvidenceKey, sampleEvidenceHash);
    });

    it("Authorized writer can anchor custody event for existing evidence", async function () {
      await expect(
        evidenceAnchor.connect(writer).anchorCustodyEvent(sampleEvidenceKey, sampleEventKey, sampleEventHash, actionType)
      )
        .to.emit(evidenceAnchor, "CustodyEventAnchored")
        .withArgs(sampleEvidenceKey, sampleEventKey, sampleEventHash, actionType, anyValue);
    });

    it("Should reject custody event anchoring for unknown evidence", async function () {
      const unknownKey = ethers.id("UNKNOWN");
      await expect(
        evidenceAnchor.connect(writer).anchorCustodyEvent(unknownKey, sampleEventKey, sampleEventHash, actionType)
      ).to.be.revertedWithCustomError(evidenceAnchor, "EvidenceNotFound");
    });

    it("Should prevent duplicate custody event anchoring (replay protection)", async function () {
      await evidenceAnchor.connect(writer).anchorCustodyEvent(sampleEvidenceKey, sampleEventKey, sampleEventHash, actionType);

      await expect(
        evidenceAnchor.connect(writer).anchorCustodyEvent(sampleEvidenceKey, sampleEventKey, sampleEventHash, actionType)
      ).to.be.revertedWithCustomError(evidenceAnchor, "CustodyEventAlreadyExists");
    });
  });

  describe("TEST GROUP 9 & 10 — HASH VERIFICATION & IMMUTABILITY", function () {
    it("Should correctly verify matching and mismatching hashes", async function () {
      await evidenceAnchor.connect(writer).registerEvidence(sampleEvidenceKey, sampleEvidenceHash);

      expect(await evidenceAnchor.verifyEvidenceHash(sampleEvidenceKey, sampleEvidenceHash)).to.be.true;

      const wrongHash = ethers.id("wrong-hash");
      expect(await evidenceAnchor.verifyEvidenceHash(sampleEvidenceKey, wrongHash)).to.be.false;
    });

    it("Evidence hash cannot be modified (immutability)", async function () {
      await evidenceAnchor.connect(writer).registerEvidence(sampleEvidenceKey, sampleEvidenceHash);
      
      // Verify no update function exists on the contract interface
      // @ts-ignore
      expect(evidenceAnchor.updateEvidenceHash).to.be.undefined;
    });
  });
});

// Helper for dynamic timestamp matching in events
const anyValue = function(value: any) {
  return true;
};