import {
  Fillo,
  FilloForm,
  FilloProvider,
  createClient,
  defineForm,
  type FilloProviderProps,
  type FormSchema,
} from "../src/index.js";

const schema: FormSchema = {
  version: 1,
  title: "Contact",
  settings: {},
  pages: [{ id: "page", blocks: [] }],
};
const codeForm = defineForm({
  id: "contact",
  title: schema.title,
  pages: schema.pages,
  settings: schema.settings,
});
const client = createClient({ key: "pk_test" });

void (<FilloForm formId="published-form" />);
void (<FilloForm form={schema} formId="published-form" client={client} />);
void (<FilloForm form={codeForm} client={client} />);
void (<FilloForm form={schema} renderOnly />);

// @ts-expect-error A plain schema plus a client still has no Fillo target.
void (<FilloForm form={schema} client={client} />);
// @ts-expect-error A code-defined form needs a keyed client unless it is render-only.
void (<FilloForm form={codeForm} />);

void (
  <FilloProvider form={schema} formId="published-form" client={client}>
    <div />
  </FilloProvider>
);
void (
  <FilloProvider form={codeForm} client={client}>
    <div />
  </FilloProvider>
);
void (
  <FilloProvider form={schema} renderOnly>
    <div />
  </FilloProvider>
);

// @ts-expect-error A plain schema cannot submit without an explicit formId.
const missingProviderTarget: FilloProviderProps = {
  form: schema,
  client,
  children: <div />,
};
void missingProviderTarget;

void (<Fillo.Form id="contact-jsx" client={client} />);
void (<Fillo.Form id="contact-jsx-preview" renderOnly />);
// @ts-expect-error JSX-authored code forms also need a client for active use.
void (<Fillo.Form id="contact-jsx-missing-client" />);
