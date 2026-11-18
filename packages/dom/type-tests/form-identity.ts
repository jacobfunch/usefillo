import { createClient, type FormSchema } from "@usefillo/core";
import { renderForm } from "../src/index.js";

const schema: FormSchema = {
  version: 1,
  title: "Contact",
  settings: {},
  pages: [{ id: "page", blocks: [] }],
};
const client = createClient({ key: "pk_test" });
declare const target: HTMLElement;

renderForm(target, { formId: "published-form" });
renderForm(target, { form: schema, formId: "published-form", client });
renderForm(target, { form: schema, renderOnly: true });

// @ts-expect-error A plain schema plus a client still has no Fillo target.
renderForm(target, { form: schema, client });
// @ts-expect-error A local schema must opt into renderOnly explicitly.
renderForm(target, { form: schema });
