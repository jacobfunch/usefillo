import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STRINGS,
  DEFAULT_RESPONDENT_ERROR_STRINGS,
  DEFAULT_FIELD_STRINGS,
  respondentErrorStringsFor,
  requiredFieldMessage,
  resolveStrings,
} from "../dist/index.js";

// ---------- new field strings (FilloFieldStrings) — templating convention ----------
//
// errorSummaryTitle/submittingAnnouncement live in FilloFieldStrings, not
// FilloStrings: apps/web's marketing docs table enumerates FilloStrings
// exhaustively (Record<keyof FilloStrings, string>) as a deliberate
// documentation-completeness gate, while FilloFieldStrings is the
// documented growth point for new strings (see its doc comment).

test("deprecated errorSummaryTitle remains stable for localization compatibility", () => {
  assert.equal(DEFAULT_FIELD_STRINGS.errorSummaryTitle, "Check these fields");
});

test("submittingAnnouncement is distinct from the 'submitting' button label", () => {
  assert.equal(typeof DEFAULT_FIELD_STRINGS.submittingAnnouncement, "string");
  assert.notEqual(DEFAULT_FIELD_STRINGS.submittingAnnouncement, DEFAULT_STRINGS.submitting);
  assert.match(DEFAULT_FIELD_STRINGS.submittingAnnouncement, /submit/i);
});

test("default respondent errors stay actionable without developer troubleshooting jargon", () => {
  const messages = [
    DEFAULT_STRINGS.loadFailedNotFound,
    DEFAULT_STRINGS.loadFailedNetwork,
    DEFAULT_STRINGS.challengeUnavailable,
  ].join(" ");
  assert.match(messages, /check the link|check your connection|refresh the page/i);
  assert.doesNotMatch(messages, /CORS|Content-Security-Policy|firewall|form id|cloudflare/i);
});

test("respondent error overrides compose with existing localized renderer strings", () => {
  const strings = resolveStrings({
    submitFailed: "Localized retry",
    closed: "Localized closed",
    respondentErrors: {
      formUnavailable: "Localized unavailable",
      scopeMissing: "Localized scope",
    },
  });
  const errors = respondentErrorStringsFor(strings);
  assert.equal(errors.submitFailed, "Localized retry");
  assert.equal(errors.formClosed, "Localized closed");
  assert.equal(errors.formUnavailable, "Localized unavailable");
  assert.equal(errors.scopeMissing, "Localized scope");
  assert.equal(errors.challengeRetry, DEFAULT_RESPONDENT_ERROR_STRINGS.challengeRetry);
});

test("rankingPosition follows the '«label», position n of m' contract template", () => {
  assert.equal(DEFAULT_FIELD_STRINGS.rankingPosition("Speed", 2, 5), "Speed, position 2 of 5");
  assert.equal(DEFAULT_FIELD_STRINGS.rankingPosition("Cost", 1, 1), "Cost, position 1 of 1");
});

test("phoneCountrySelected announces the picked country by name", () => {
  assert.equal(DEFAULT_FIELD_STRINGS.phoneCountrySelected("Denmark"), "Denmark selected");
});

test("phoneResultsCount pluralizes like the existing upload count strings", () => {
  assert.equal(DEFAULT_FIELD_STRINGS.phoneResultsCount(1), "1 result");
  assert.equal(DEFAULT_FIELD_STRINGS.phoneResultsCount(0), "0 results");
  assert.equal(DEFAULT_FIELD_STRINGS.phoneResultsCount(5), "5 results");
});

test("upload row chrome has stable action names and visible status templates", () => {
  assert.equal(DEFAULT_FIELD_STRINGS.uploadCancel, "Cancel");
  assert.equal(DEFAULT_FIELD_STRINGS.uploadRemove, "Remove");
  assert.equal(DEFAULT_FIELD_STRINGS.uploadDismiss, "Dismiss");
  assert.equal(DEFAULT_FIELD_STRINGS.uploadingFile(42, "2.0 MB"), "Uploading · 42% · 2.0 MB");
  assert.equal(DEFAULT_FIELD_STRINGS.uploadedFile("2.0 MB"), "Uploaded · 2.0 MB");
});

test("signature signed/empty state labels are distinct, non-empty strings", () => {
  assert.equal(typeof DEFAULT_FIELD_STRINGS.signatureEmpty, "string");
  assert.equal(typeof DEFAULT_FIELD_STRINGS.signatureSigned, "string");
  assert.notEqual(DEFAULT_FIELD_STRINGS.signatureEmpty, DEFAULT_FIELD_STRINGS.signatureSigned);
  assert.ok(DEFAULT_FIELD_STRINGS.signatureEmpty.length > 0);
  assert.ok(DEFAULT_FIELD_STRINGS.signatureSigned.length > 0);
});

test("required messages give each field family an actionable default", () => {
  const message = (kind) =>
    requiredFieldMessage({ id: kind, kind, label: kind }, DEFAULT_FIELD_STRINGS);
  assert.equal(message("short_text"), "Enter your answer");
  assert.equal(message("email"), "Enter an email address");
  assert.equal(message("multi_select"), "Select at least one option");
  assert.equal(message("signature"), "Add your signature");
  assert.equal(message("file_upload"), "Add a file");
  assert.equal(message("custom"), "This field is required");
});

// ---------- resolveStrings: new keys participate in override merging ----------

test("resolveStrings includes the new keys by default", () => {
  const resolved = resolveStrings();
  assert.equal(resolved.errorSummaryTitle, "Check these fields");
  assert.equal(resolved.rankingPosition("X", 1, 3), "X, position 1 of 3");
  assert.equal(resolved.signatureEmpty, "No signature yet");
});

test("resolveStrings lets overrides replace any of the new keys individually", () => {
  const resolved = resolveStrings({
    errorSummaryTitle: "Fix these:",
    rankingPosition: (label, position, count) => `${label} (${position}/${count})`,
  });
  assert.equal(resolved.errorSummaryTitle, "Fix these:");
  assert.equal(resolved.rankingPosition("X", 1, 3), "X (1/3)");
  // Untouched keys keep their defaults.
  assert.equal(resolved.signatureSigned, "Signature saved");
  assert.equal(resolved.phoneCountrySelected("Kenya"), "Kenya selected");
});

test("resolveStrings localizes upload row actions and visible statuses independently", () => {
  const resolved = resolveStrings({
    uploadCancel: "Annuler",
    uploadRemove: "Retirer",
    uploadDismiss: "Fermer",
    uploadingFile: (percent, size) => `Téléversement · ${percent} % · ${size}`,
    uploadedFile: (size) => `Téléversé · ${size}`,
  });
  assert.equal(resolved.uploadCancel, "Annuler");
  assert.equal(resolved.uploadRemove, "Retirer");
  assert.equal(resolved.uploadDismiss, "Fermer");
  assert.equal(resolved.uploadingFile(8, "10 KB"), "Téléversement · 8 % · 10 KB");
  assert.equal(resolved.uploadedFile("10 KB"), "Téléversé · 10 KB");
  assert.equal(resolved.uploadRetry, "Retry", "unrelated upload copy keeps its default");
});

test("a legacy generic required override suppresses field-aware English defaults", () => {
  const resolved = resolveStrings({ required: "Champ obligatoire" });
  assert.equal(resolved.requiredForField, undefined);
  assert.equal(
    requiredFieldMessage({ id: "email", kind: "email", label: "Email" }, resolved),
    "Champ obligatoire",
  );
});

test("requiredForField can localize by kind while retaining the generic fallback", () => {
  const resolved = resolveStrings({
    required: "Champ obligatoire",
    requiredForField: (field) =>
      field.kind === "file_upload" ? "Ajoutez un fichier" : "Saisissez votre réponse",
  });
  assert.equal(
    requiredFieldMessage({ id: "files", kind: "file_upload", label: "Fichiers" }, resolved),
    "Ajoutez un fichier",
  );
  assert.equal(
    requiredFieldMessage({ id: "name", kind: "short_text", label: "Nom" }, resolved),
    "Saisissez votre réponse",
  );
});
