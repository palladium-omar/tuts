import { useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Modal, Notice } from "../components/shared";
import { DatePicker } from "../components/date-picker";
import { errorMessage, type Api, type Row } from "../lib/api";

export type CRMField = {
  id: string;
  key: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "boolean";
  options?: string[];
};
export type CRMFilter = {
  field: string;
  operator: "contains" | "equals" | "gt" | "lt" | "is_empty" | "is_not_empty";
  value?: string | number | boolean;
};
export type CRMColumn = { key: string; label: string; sort?: string };
export const builtinColumns: CRMColumn[] = [
  { key: "displayName", label: "Contact", sort: "displayName" },
  { key: "status", label: "Stage", sort: "status" },
  { key: "contactDetails", label: "Email / phone" },
  { key: "sourceTags", label: "Source / tags" },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "kind", label: "Relationship" },
  { key: "source", label: "Source" },
  { key: "tags", label: "Tags" },
  { key: "createdAt", label: "Added", sort: "createdAt" },
  { key: "emailOptIn", label: "Email permission" },
  { key: "whatsappOptIn", label: "WhatsApp permission" },
];
export const defaultColumns = [
  "displayName",
  "status",
  "contactDetails",
  "sourceTags",
];
export function columnCell(row: Row, column: CRMColumn, fields: CRMField[]) {
  if (column.key.startsWith("custom:")) {
    const field = fields.find((f) => `custom:${f.id}` === column.key),
      value = row.customFields?.[column.key.slice(7)];
    return value == null || value === ""
      ? "—"
      : field?.type === "boolean"
        ? value
          ? "Yes"
          : "No"
        : String(value);
  }
  switch (column.key) {
    case "displayName":
      return (
        <>
          <strong>{row.displayName}</strong>
          <small>{row.kind === "payer" ? "Parent / payer" : "Student"}</small>
        </>
      );
    case "status":
      return (
        <span className={`status ${row.status}`}>{row.status ?? "active"}</span>
      );
    case "contactDetails":
      return (
        <>
          {row.email ?? "—"}
          <small>{row.phone}</small>
        </>
      );
    case "sourceTags":
      return (
        <>
          {row.source === "file-import"
            ? "Spreadsheet import"
            : (row.source ?? "Added manually")}
          <div className="tag-list">
            {row.tags?.map((t: string) => (
              <span className="tag" key={t}>
                {t}
              </span>
            ))}
          </div>
        </>
      );
    case "tags":
      return row.tags?.join(", ") || "—";
    case "kind":
      return row.kind === "payer" ? "Parent / payer" : "Student";
    case "createdAt":
      return row.createdAt ? new Date(row.createdAt).toLocaleDateString() : "—";
    case "emailOptIn":
    case "whatsappOptIn":
      return row[column.key] === true ? "Permitted" : "Not permitted";
    default:
      return row[column.key] || "—";
  }
}
export function CustomFieldInputs({
  fields,
  values,
}: {
  fields: CRMField[];
  values: Row;
}) {
  return (
    <>
      {fields.map((field) =>
        field.type === "date" ? (
          <DatePicker
            key={field.id}
            name={`custom:${field.id}`}
            label={field.label}
            defaultValue={values[field.id] ?? ""}
          />
        ) : (
          <label key={field.id}>
            {field.label}
            {field.type === "select" || field.type === "boolean" ? (
              <select
                name={`custom:${field.id}`}
                defaultValue={
                  values[field.id] == null ? "" : String(values[field.id])
                }
              >
                <option value="">No value</option>
                {field.type === "boolean" ? (
                  <>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </>
                ) : (
                  field.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))
                )}
              </select>
            ) : (
              <input
                name={`custom:${field.id}`}
                type={field.type === "number" ? "number" : "text"}
                step={field.type === "number" ? "any" : undefined}
                maxLength={field.type === "text" ? 4000 : undefined}
                defaultValue={values[field.id] ?? ""}
              />
            )}
          </label>
        ),
      )}
    </>
  );
}
export function customFieldValues(form: FormData, fields: CRMField[]) {
  return Object.fromEntries(
    fields.map((field) => {
      const raw = String(form.get(`custom:${field.id}`) ?? "").trim();
      if (!raw) return [field.id, null];
      if (field.type === "number") {
        if (!Number.isFinite(Number(raw)))
          throw new Error(`${field.label} needs a valid number.`);
        return [field.id, Number(raw)];
      }
      if (field.type === "boolean") return [field.id, raw === "true"];
      if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(raw))
        throw new Error(`${field.label} needs a valid date.`);
      if (field.type === "select" && !field.options?.includes(raw))
        throw new Error(`Choose an available option for ${field.label}.`);
      return [field.id, raw];
    }),
  );
}
export function ColumnsDialog({
  api,
  columns,
  visible,
  fields,
  canManage,
  onChange,
  onField,
  onClose,
}: {
  api: Api;
  columns: CRMColumn[];
  visible: string[];
  fields: CRMField[];
  canManage: boolean;
  onChange: (keys: string[]) => void;
  onField: (field: CRMField) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [type, setType] = useState<CRMField["type"]>("text"),
    [editing, setEditing] = useState<CRMField | null>(null);
  const ordered = [
    ...visible
      .map((key) => columns.find((c) => c.key === key))
      .filter((c): c is CRMColumn => !!c),
    ...columns.filter((c) => !visible.includes(c.key)),
  ];
  function move(key: string, delta: number) {
    const next = [...visible],
      at = next.indexOf(key);
    [next[at], next[at + delta]] = [next[at + delta], next[at]];
    onChange(next);
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const element = e.currentTarget;
    const form = new FormData(element);
    const options = String(form.get("options") ?? "")
      .split("\n")
      .map((o) => o.trim())
      .filter(Boolean);
    if (type === "select" && !options.length) {
      setError("Add at least one option for this field.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `clients/v1/fields${editing ? `/${editing.id}` : ""}`,
        editing ? "PATCH" : "POST",
        {
          label: String(form.get("label") ?? "").trim(),
          ...(!editing ? { type } : {}),
          ...(type === "select" ? { options } : {}),
        },
      );
      onField(result.item);
      setEditing(null);
      setType("text");
      element.reset();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="CRM columns"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="crm-helper">
        Choose the columns and their order for this business on this browser.
      </p>
      <div className="crm-column-list">
        {ordered.map((column) => {
          const at = visible.indexOf(column.key),
            field = fields.find((f) => `custom:${f.id}` === column.key);
          return (
            <div className="crm-column-option" key={column.key}>
              <label className="crm-check">
                <input
                  type="checkbox"
                  checked={at !== -1}
                  disabled={at !== -1 && visible.length === 1}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...visible, column.key]
                        : visible.filter((k) => k !== column.key),
                    )
                  }
                />
                {column.label}
              </label>
              <div className="crm-column-moves">
                {field && canManage && (
                  <button
                    aria-label={`Edit field ${field.label}`}
                    onClick={() => {
                      setEditing(field);
                      setType(field.type);
                      setError("");
                    }}
                  >
                    Edit field
                  </button>
                )}
                <button
                  aria-label={`Move ${column.label} up`}
                  disabled={at <= 0}
                  onClick={() => move(column.key, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  aria-label={`Move ${column.label} down`}
                  disabled={at < 0 || at === visible.length - 1}
                  onClick={() => move(column.key, 1)}
                >
                  <ArrowDown size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {canManage && (
        <form
          onSubmit={save}
          className="crm-new-field"
          key={editing?.id ?? "new"}
        >
          <h3>{editing ? "Edit custom field" : "Add a custom field"}</h3>
          <Notice error={error} />
          <div className="form-grid">
            <label>
              Field label
              <input
                name="label"
                required
                maxLength={80}
                defaultValue={editing?.label ?? ""}
              />
            </label>
            <label>
              Field type
              <select
                value={type}
                disabled={!!editing || busy}
                onChange={(e) => setType(e.target.value as CRMField["type"])}
              >
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="date">Date</option>
                <option value="select">Choice</option>
                <option value="boolean">Yes / no</option>
              </select>
            </label>
          </div>
          {type === "select" && (
            <label>
              Options, one per line
              <textarea
                name="options"
                rows={3}
                maxLength={8000}
                required
                defaultValue={editing?.options?.join("\n") ?? ""}
              />
            </label>
          )}
          <div className="form-actions">
            {editing && (
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setType("text");
                  setError("");
                }}
              >
                Cancel field edit
              </button>
            )}
            <button disabled={busy} className="primary">
              {busy ? "Saving…" : editing ? "Save field" : "Add field"}
            </button>
          </div>
        </form>
      )}
      <div className="form-actions">
        <button onClick={onClose} disabled={busy}>
          Done
        </button>
      </div>
    </Modal>
  );
}
const filterBuiltins = [
  { key: "displayName", label: "Contact name", type: "text" },
  { key: "firstName", label: "First name", type: "text" },
  { key: "lastName", label: "Last name", type: "text" },
  { key: "email", label: "Email", type: "text" },
  { key: "phone", label: "Phone", type: "text" },
  {
    key: "status",
    label: "Stage",
    type: "select",
    options: ["lead", "active", "inactive"],
  },
  {
    key: "kind",
    label: "Relationship",
    type: "select",
    options: ["student", "payer"],
  },
  { key: "source", label: "Source", type: "text" },
  { key: "tags", label: "Tags", type: "text" },
  { key: "createdAt", label: "Date added", type: "date" },
  { key: "emailOptIn", label: "Email updates permitted", type: "boolean" },
  {
    key: "whatsappOptIn",
    label: "WhatsApp updates permitted",
    type: "boolean",
  },
];
export function FiltersDialog({
  selectionHint = "Selection clears when filters change.",
  fields,
  filters,
  onApply,
  onClose,
}: {
  selectionHint?: string;
  fields: CRMField[];
  filters: CRMFilter[];
  onApply: (filters: CRMFilter[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CRMFilter[]>(filters),
    [error, setError] = useState("");
  const definitions = [
    ...filterBuiltins,
    ...fields.map((f) => ({ ...f, key: `custom:${f.id}` })),
  ];
  function change(at: number, patch: Partial<CRMFilter>) {
    setDraft(draft.map((f, i) => (i === at ? { ...f, ...patch } : f)));
  }
  function apply(e: FormEvent) {
    e.preventDefault();
    const invalid = draft.some(
      (f) =>
        !f.operator.startsWith("is_") &&
        (f.value === undefined || f.value === ""),
    );
    if (invalid) {
      setError("Enter a value for each filter or choose an empty-value rule.");
      return;
    }
    onApply(draft);
    onClose();
  }
  return (
    <Modal title="Filter contacts" onClose={onClose}>
      <form onSubmit={apply}>
        <p className="crm-helper">
          Contacts must match every rule. {selectionHint}
        </p>
        <Notice error={error} />
        <div className="crm-filter-rules">
          {draft.map((filter, index) => {
            const def =
                definitions.find((d) => d.key === filter.field) ??
                definitions[0],
              numeric = def.type === "number" || def.type === "date",
              operators = numeric
                ? ["equals", "gt", "lt", "is_empty", "is_not_empty"]
                : def.type === "text"
                  ? ["contains", "equals", "is_empty", "is_not_empty"]
                  : ["equals", "is_empty", "is_not_empty"];
            return (
              <div className="crm-filter-rule" key={index}>
                <label>
                  Field
                  <select
                    aria-label={`Filter ${index + 1} field`}
                    value={filter.field}
                    onChange={(e) =>
                      change(index, {
                        field: e.target.value,
                        operator: "equals",
                        value: undefined,
                      })
                    }
                  >
                    {definitions.map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Rule
                  <select
                    aria-label={`Filter ${index + 1} rule`}
                    value={filter.operator}
                    onChange={(e) =>
                      change(index, {
                        operator: e.target.value as CRMFilter["operator"],
                      })
                    }
                  >
                    {operators.map((o) => (
                      <option key={o} value={o}>
                        {
                          (
                            {
                              contains: "Contains",
                              equals: "Equals",
                              gt:
                                def.type === "date" ? "After" : "Greater than",
                              lt: def.type === "date" ? "Before" : "Less than",
                              is_empty: "Is empty",
                              is_not_empty: "Is not empty",
                            } as Record<string, string>
                          )[o]
                        }
                      </option>
                    ))}
                  </select>
                </label>
                {!filter.operator.startsWith("is_") &&
                  (def.type === "date" ? (
                    <DatePicker
                      name={`filter-date-${index}`}
                      label={`Filter ${index + 1} value`}
                      value={filter.value == null ? "" : String(filter.value)}
                      onChange={(value) => change(index, { value })}
                      required
                    />
                  ) : (
                    <label>
                      Value
                      {def.type === "select" || def.type === "boolean" ? (
                        <select
                          aria-label={`Filter ${index + 1} value`}
                          value={
                            filter.value == null ? "" : String(filter.value)
                          }
                          onChange={(e) =>
                            change(index, {
                              value:
                                def.type === "boolean"
                                  ? e.target.value === ""
                                    ? undefined
                                    : e.target.value === "true"
                                  : e.target.value,
                            })
                          }
                        >
                          <option value="">Choose…</option>
                          {def.type === "boolean" ? (
                            <>
                              <option value="true">Yes</option>
                              <option value="false">No</option>
                            </>
                          ) : (
                            def.options?.map((o) => (
                              <option value={o} key={o}>
                                {o}
                              </option>
                            ))
                          )}
                        </select>
                      ) : (
                        <input
                          aria-label={`Filter ${index + 1} value`}
                          type={def.type === "number" ? "number" : "text"}
                          step={def.type === "number" ? "any" : undefined}
                          maxLength={4000}
                          value={
                            filter.value == null ? "" : String(filter.value)
                          }
                          onChange={(e) =>
                            change(index, {
                              value:
                                def.type === "number"
                                  ? e.target.value === ""
                                    ? undefined
                                    : Number(e.target.value)
                                  : e.target.value,
                            })
                          }
                        />
                      )}
                    </label>
                  ))}
                <button
                  type="button"
                  aria-label={`Remove filter ${index + 1}`}
                  onClick={() => setDraft(draft.filter((_, i) => i !== index))}
                >
                  <X size={15} />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          disabled={draft.length >= 20}
          onClick={() =>
            setDraft([
              ...draft,
              { field: "displayName", operator: "contains", value: "" },
            ])
          }
        >
          Add rule
        </button>
        <div className="form-actions">
          <button type="button" onClick={() => setDraft([])}>
            Clear rules
          </button>
          <button className="primary">Apply filters</button>
        </div>
      </form>
    </Modal>
  );
}
