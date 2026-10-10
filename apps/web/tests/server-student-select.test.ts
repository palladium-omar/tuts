import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServerStudentSelect, studentSelectionPath } from "../features/server-student-select";

test("student selection queries one bounded page with encoded server search", () => {
  const path = studentSelectionPath("  A&B + student@example.com  ", 200);
  const query = new URLSearchParams(path.split("?")[1]);
  assert.equal(path.split("?")[0], "clients/v1/clients");
  assert.equal(query.get("kind"), "student");
  assert.equal(query.get("limit"), "100");
  assert.equal(query.get("offset"), "200");
  assert.equal(query.get("search"), "A&B + student@example.com");
  assert.equal(query.get("sortBy"), "displayName");
  assert.equal(new URLSearchParams(studentSelectionPath("", -100).split("?")[1]).get("offset"), "0");
  assert.equal(new URLSearchParams(studentSelectionPath("", NaN).split("?")[1]).get("offset"), "0");
  assert.equal(new URLSearchParams(studentSelectionPath("x".repeat(200), 0).split("?")[1]).get("search")?.length, 160);
});

test("selected student remains in the field without loading a full contact list", () => {
  const api = async () => { throw new Error("Static rendering must not request contacts"); };
  const html = renderToStaticMarkup(createElement(ServerStudentSelect, { api, value: "selected-student-id", selectedName: "Maya Sample", onChange: () => {}, emptyLabel: "All students", label: "Filter assignments by student" }));
  assert.match(html, /Maya Sample \(selected\)/);
  assert.match(html, /value="selected-student-id" selected/);
  assert.match(html, /All students/);
  assert.match(html, /aria-label="Filter assignments by student"/);
  assert.doesNotMatch(html, /Add a student in CRM/);
});

test("locked recipient is still submitted after an attachment has uploaded", () => {
  const api = async () => ({});
  const html = renderToStaticMarkup(createElement(ServerStudentSelect, { api, name: "clientId", value: "selected-student-id", selectedName: "Maya Sample", onChange: () => {}, disabled: true, required: true, initiallyOpen: true }));
  assert.match(html, /type="hidden" name="clientId" value="selected-student-id"/);
  assert.match(html, /required="" disabled=""/);
  assert.match(html, /type="button" aria-expanded="true"/);
});
