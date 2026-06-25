import { pool, withTransaction, type Executor } from './db.js';
import { buildReminderSchedule, simulateSend } from './services/reminders.js';
import { DEFAULT_PLAN, PLANS, serializeLimits, type Plan } from './plans.js';
import type {
  Product,
  Customer,
  Invoice,
  InvoiceItem,
  Transaction,
  WhatsAppReminder,
  User,
  UserRole,
  Business,
  Account,
  Store,
} from './types.js';

/** Error that carries an HTTP status for the route layer. */
export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const code = () => Math.random().toString(36).slice(2, 8).toUpperCase();

// ---------------------------------------------------------------------------
// Query helpers — convert `?` placeholders to Postgres `$1, $2, ...`.
// ---------------------------------------------------------------------------

const toPg = (sql: string): string => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

async function one<T>(ex: Executor, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const res = await ex.query(toPg(sql), params);
  return res.rows[0] as T | undefined;
}

async function many<T>(ex: Executor, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await ex.query(toPg(sql), params);
  return res.rows as T[];
}

/** Runs a write and returns the number of affected rows. */
async function run(ex: Executor, sql: string, params: unknown[] = []): Promise<number> {
  const res = await ex.query(toPg(sql), params);
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Accounts (billing entity / owner organisation)
// ---------------------------------------------------------------------------

async function uniqueJoinCode(): Promise<string> {
  let joinCode = code();
  while (
    (await one(pool, 'SELECT 1 FROM accounts WHERE "joinCode" = ?', [joinCode])) ||
    (await one(pool, 'SELECT 1 FROM businesses WHERE "joinCode" = ?', [joinCode]))
  ) {
    joinCode = code();
  }
  return joinCode;
}

export async function createAccount(name: string, client?: Executor): Promise<Account> {
  const ex = client ?? pool;
  const account: Account = { id: id('acc'), name, joinCode: await uniqueJoinCode(), plan: DEFAULT_PLAN, createdAt: now() };
  await run(ex, 'INSERT INTO accounts (id, name, "joinCode", plan, "createdAt") VALUES (?, ?, ?, ?, ?)', [
    account.id, account.name, account.joinCode, account.plan, account.createdAt,
  ]);
  return account;
}

export const findAccountById = (accountId: string): Promise<Account | undefined> =>
  one<Account>(pool, 'SELECT * FROM accounts WHERE id = ?', [accountId]);

export const findAccountByJoinCode = (joinCode: string): Promise<Account | undefined> =>
  one<Account>(pool, 'SELECT * FROM accounts WHERE "joinCode" = ?', [joinCode.trim().toUpperCase()]);

export async function setAccountPlan(accountId: string, plan: Plan): Promise<void> {
  await run(pool, 'UPDATE accounts SET plan = ? WHERE id = ?', [plan, accountId]);
}

/** Account plus its plan limits and current usage — drives the Plans UI and gating. */
export interface AccountView extends Account {
  limits: ReturnType<typeof serializeLimits>;
  usage: { stores: number; staff: number; remindersThisMonth: number };
}

export async function loadAccountView(accountId: string): Promise<AccountView | undefined> {
  const account = await findAccountById(accountId);
  if (!account) return undefined;
  const [stores, staff, remindersThisMonth] = await Promise.all([
    countActiveStores(accountId),
    countStaff(accountId),
    countRemindersSentThisMonth(accountId),
  ]);
  return {
    ...account,
    limits: serializeLimits(PLANS[account.plan] ?? PLANS[DEFAULT_PLAN]),
    usage: { stores, staff, remindersThisMonth },
  };
}

export async function setAccountSubscription(
  accountId: string,
  fields: { plan?: Plan; razorpaySubscriptionId?: string | null; subscriptionStatus?: string | null; currentPeriodEnd?: string | null },
): Promise<void> {
  const acct = await findAccountById(accountId);
  if (!acct) throw new HttpError('Account not found.', 404);
  await run(
    pool,
    'UPDATE accounts SET plan = ?, "razorpaySubscriptionId" = ?, "subscriptionStatus" = ?, "currentPeriodEnd" = ? WHERE id = ?',
    [
      fields.plan ?? acct.plan,
      fields.razorpaySubscriptionId === undefined ? acct.razorpaySubscriptionId ?? null : fields.razorpaySubscriptionId,
      fields.subscriptionStatus === undefined ? acct.subscriptionStatus ?? null : fields.subscriptionStatus,
      fields.currentPeriodEnd === undefined ? acct.currentPeriodEnd ?? null : fields.currentPeriodEnd,
      accountId,
    ],
  );
}

// ---------------------------------------------------------------------------
// Stores (a "business" row belongs to an account)
// ---------------------------------------------------------------------------

export async function createStore(accountId: string, name: string, client?: Executor): Promise<Store> {
  const ex = client ?? pool;
  const store: Store = { id: id('biz'), accountId, name, joinCode: await uniqueJoinCode(), gstRate: 18, locked: false, createdAt: now() };
  await run(
    ex,
    'INSERT INTO businesses (id, "accountId", name, "joinCode", "gstRate", locked, "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
    [store.id, accountId, store.name, store.joinCode, store.gstRate, store.locked, store.createdAt],
  );
  return store;
}

export const findBusinessById = (businessId: string): Promise<Business | undefined> =>
  one<Business>(pool, 'SELECT * FROM businesses WHERE id = ?', [businessId]);

export const listStoresForAccount = (accountId: string): Promise<Store[]> =>
  many<Store>(pool, 'SELECT * FROM businesses WHERE "accountId" = ? ORDER BY "createdAt" ASC', [accountId]);

/** Active (non-locked) store count for an account — used to enforce the plan limit. */
export async function countActiveStores(accountId: string): Promise<number> {
  const row = await one<{ n: string }>(pool, 'SELECT COUNT(*) AS n FROM businesses WHERE "accountId" = ? AND locked = false', [accountId]);
  return Number(row?.n ?? 0);
}

export async function setStoreLocked(accountId: string, businessId: string, locked: boolean): Promise<void> {
  const changes = await run(pool, 'UPDATE businesses SET locked = ? WHERE id = ? AND "accountId" = ?', [locked, businessId, accountId]);
  if (changes === 0) throw new HttpError('Store not found.', 404);
}

export async function updateBusiness(
  businessId: string,
  fields: Partial<Pick<Business, 'name' | 'address' | 'gstIn' | 'phone' | 'logo' | 'upiVpa' | 'gstRate'>>,
): Promise<Business> {
  const current = await findBusinessById(businessId);
  if (!current) throw new HttpError('Store not found.', 404);
  const gstRate = fields.gstRate ?? current.gstRate ?? 18;
  await run(
    pool,
    'UPDATE businesses SET name = ?, address = ?, "gstIn" = ?, phone = ?, logo = ?, "upiVpa" = ?, "gstRate" = ? WHERE id = ?',
    [
      fields.name?.trim() || current.name,
      fields.address ?? current.address ?? null,
      (fields.gstIn ?? current.gstIn ?? null) || null,
      fields.phone ?? current.phone ?? null,
      fields.logo ?? current.logo ?? null,
      fields.upiVpa ?? current.upiVpa ?? null,
      Math.min(100, Math.max(0, gstRate)),
      businessId,
    ],
  );
  return (await findBusinessById(businessId))!;
}

// ---------------------------------------------------------------------------
// Memberships (which stores a STAFF user can access; owners access all)
// ---------------------------------------------------------------------------

export async function addMembership(userId: string, businessId: string, client?: Executor): Promise<void> {
  await run(
    client ?? pool,
    'INSERT INTO memberships (id, "userId", "businessId", "createdAt") VALUES (?, ?, ?, ?) ON CONFLICT ("userId", "businessId") DO NOTHING',
    [id('mem'), userId, businessId, now()],
  );
}

export async function removeMembership(userId: string, businessId: string): Promise<void> {
  await run(pool, 'DELETE FROM memberships WHERE "userId" = ? AND "businessId" = ?', [userId, businessId]);
}

/** Replaces a STAFF user's accessible stores with exactly `storeIds` (validated to the account). */
export async function setStaffStores(accountId: string, userId: string, storeIds: string[]): Promise<void> {
  return withTransaction(async (client) => {
    const u = await one<{ role: UserRole; accountId: string }>(client, 'SELECT role, "accountId" FROM users WHERE id = ?', [userId]);
    if (!u || u.accountId !== accountId) throw new HttpError('Staff member not found.', 404);
    if (u.role !== 'STAFF') throw new HttpError("Only a staff member's store access can be changed.", 400);
    const stores = await many<{ id: string }>(client, 'SELECT id FROM businesses WHERE "accountId" = ?', [accountId]);
    const valid = new Set(stores.map((s) => s.id));
    await run(client, 'DELETE FROM memberships WHERE "userId" = ?', [userId]);
    for (const sid of storeIds.filter((s) => valid.has(s))) await addMembership(userId, sid, client);
  });
}

const listMembershipStoreIds = (userId: string): Promise<{ businessId: string }[]> =>
  many<{ businessId: string }>(pool, 'SELECT "businessId" FROM memberships WHERE "userId" = ?', [userId]);

/** Stores a user may operate on: owners get every store in the account; staff get assigned ones. */
export async function listAccessibleStores(user: Pick<User, 'id' | 'accountId' | 'role'>): Promise<Store[]> {
  if (user.role === 'OWNER') return listStoresForAccount(user.accountId);
  return many<Store>(
    pool,
    `SELECT b.* FROM businesses b
       JOIN memberships m ON m."businessId" = b.id
      WHERE m."userId" = ? AND b."accountId" = ?
      ORDER BY b."createdAt" ASC`,
    [user.id, user.accountId],
  );
}

/** True if `user` may operate on `businessId` (same account, and owner or member). */
export async function userCanAccessStore(user: Pick<User, 'id' | 'accountId' | 'role'>, businessId: string): Promise<boolean> {
  const store = await findBusinessById(businessId);
  if (!store || store.accountId !== user.accountId) return false;
  if (user.role === 'OWNER') return true;
  const member = await one(pool, 'SELECT 1 FROM memberships WHERE "userId" = ? AND "businessId" = ?', [user.id, businessId]);
  return Boolean(member);
}

/**
 * Resolves the store a request should act on: the requested one (if the user may
 * access it), else the user's primary store, else their first accessible store.
 * Throws 403 if the user has no accessible store or no access to the requested one.
 */
export async function resolveActiveStore(
  user: Pick<User, 'id' | 'accountId' | 'role' | 'businessId'>,
  requestedStoreId?: string,
): Promise<Store> {
  if (requestedStoreId) {
    if (!(await userCanAccessStore(user, requestedStoreId))) {
      throw new HttpError('You do not have access to this store.', 403);
    }
    return (await findBusinessById(requestedStoreId))!;
  }
  const stores = await listAccessibleStores(user);
  if (stores.length === 0) {
    throw new HttpError('No store is assigned to your login yet. Ask the owner to assign you one.', 403);
  }
  return stores.find((s) => s.id === user.businessId) ?? stores[0];
}

// ---------------------------------------------------------------------------
// Users (auth)
// ---------------------------------------------------------------------------

interface UserRow extends User {
  passwordHash: string;
  createdAt: string;
}

export async function createUser(
  accountId: string,
  businessId: string,
  name: string,
  email: string,
  passwordHash: string,
  role: UserRole,
  client?: Executor,
): Promise<User> {
  const user = { id: id('u'), accountId, businessId, name, email: email.toLowerCase(), role, createdAt: now() };
  await run(
    client ?? pool,
    `INSERT INTO users (id, "accountId", "businessId", name, email, "passwordHash", role, "createdAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.id, accountId, businessId, name, user.email, passwordHash, role, user.createdAt],
  );
  return { id: user.id, accountId, businessId, name: user.name, email: user.email, role: user.role };
}

export const findUserByEmail = (email: string): Promise<UserRow | undefined> =>
  one<UserRow>(pool, 'SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);

export const findUserById = (userId: string): Promise<User | undefined> =>
  one<User>(pool, 'SELECT id, "accountId", "businessId", name, email, role FROM users WHERE id = ?', [userId]);

/** Staff (and owner) in an account, with the stores each can access. */
export interface StaffMember {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  storeIds: string[];
}

export async function listAccountUsers(accountId: string): Promise<StaffMember[]> {
  const users = await many<{ id: string; name: string; email: string; role: UserRole }>(
    pool,
    'SELECT id, name, email, role FROM users WHERE "accountId" = ? ORDER BY "createdAt" ASC',
    [accountId],
  );
  const stores = await listStoresForAccount(accountId);
  const allStoreIds = stores.map((s) => s.id);
  const result: StaffMember[] = [];
  for (const u of users) {
    const storeIds =
      u.role === 'OWNER'
        ? allStoreIds
        : (await listMembershipStoreIds(u.id)).map((m) => m.businessId).filter((bid) => allStoreIds.includes(bid));
    result.push({ ...u, storeIds });
  }
  return result;
}

export async function countStaff(accountId: string): Promise<number> {
  const row = await one<{ n: string }>(pool, `SELECT COUNT(*) AS n FROM users WHERE "accountId" = ? AND role = 'STAFF'`, [accountId]);
  return Number(row?.n ?? 0);
}

/** Throws 403 when the account has hit its monthly reminder cap (no-op for unlimited). */
export async function assertReminderQuota(accountId: string): Promise<void> {
  const account = await findAccountById(accountId);
  if (!account) throw new HttpError('Account not found.', 404);
  const plan = PLANS[account.plan] ?? PLANS[DEFAULT_PLAN];
  if (!Number.isFinite(plan.reminderCap)) return; // unlimited
  if ((await countRemindersSentThisMonth(accountId)) >= plan.reminderCap) {
    throw new HttpError(
      `Monthly reminder limit reached (${plan.reminderCap}) on the ${plan.label} plan. Upgrade to send more this month.`,
      403,
    );
  }
}

/** AI WhatsApp reminders marked SENT this calendar month, across all the account's stores. */
export async function countRemindersSentThisMonth(accountId: string): Promise<number> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const row = await one<{ n: string }>(
    pool,
    `SELECT COUNT(*) AS n
       FROM reminders r JOIN businesses b ON b.id = r."businessId"
      WHERE b."accountId" = ? AND r.status = 'SENT' AND r."sentAt" >= ?`,
    [accountId, monthStart.toISOString()],
  );
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Reads (all scoped to a business)
// ---------------------------------------------------------------------------

const mapInvoice = (row: Omit<Invoice, 'items'> & { items: string }): Invoice => ({
  ...row,
  items: JSON.parse(row.items) as InvoiceItem[],
});

export const listProducts = (businessId: string): Promise<Product[]> =>
  many<Product>(pool, 'SELECT * FROM products WHERE "businessId" = ? ORDER BY "createdAt" DESC', [businessId]);

export const listCustomers = (businessId: string): Promise<Customer[]> =>
  many<Customer>(pool, 'SELECT * FROM customers WHERE "businessId" = ? ORDER BY "createdAt" DESC', [businessId]);

export async function listInvoices(businessId: string): Promise<Invoice[]> {
  const rows = await many<Omit<Invoice, 'items'> & { items: string }>(
    pool,
    'SELECT * FROM invoices WHERE "businessId" = ? ORDER BY "createdAt" DESC',
    [businessId],
  );
  return rows.map(mapInvoice);
}

export const listTransactions = (businessId: string): Promise<Transaction[]> =>
  many<Transaction>(pool, 'SELECT * FROM transactions WHERE "businessId" = ? ORDER BY "createdAt" DESC', [businessId]);

export const listReminders = (businessId: string): Promise<WhatsAppReminder[]> =>
  many<WhatsAppReminder>(pool, 'SELECT * FROM reminders WHERE "businessId" = ? ORDER BY "scheduledFor" ASC', [businessId]);

export interface Snapshot {
  products: Product[];
  customers: Customer[];
  invoices: Invoice[];
  transactions: Transaction[];
  reminders: WhatsAppReminder[];
}

export async function snapshot(businessId: string): Promise<Snapshot> {
  const [products, customers, invoices, transactions, reminders] = await Promise.all([
    listProducts(businessId),
    listCustomers(businessId),
    listInvoices(businessId),
    listTransactions(businessId),
    listReminders(businessId),
  ]);
  return { products, customers, invoices, transactions, reminders };
}

// ---------------------------------------------------------------------------
// Inventory & customers
// ---------------------------------------------------------------------------

const INSERT_PRODUCT =
  `INSERT INTO products (id, "businessId", sku, barcode, name, category, "unitType", "costPrice", "retailPrice", "wholesalePrice", "currentStock", "lowStockThreshold", "createdAt")
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const productValues = (p: Product, businessId: string): unknown[] => [
  p.id, businessId, p.sku, p.barcode ?? null, p.name, p.category, p.unitType,
  p.costPrice, p.retailPrice, p.wholesalePrice, p.currentStock, p.lowStockThreshold, p.createdAt,
];

export async function createProduct(businessId: string, input: Omit<Product, 'id' | 'createdAt'>): Promise<Product> {
  const product: Product = { ...input, id: id('p'), createdAt: now() };
  await run(pool, INSERT_PRODUCT, productValues(product, businessId));
  return product;
}

/** Bulk-create products (CSV import / starter catalog). Returns the count added. */
export async function createProductsBulk(businessId: string, items: Omit<Product, 'id' | 'createdAt'>[]): Promise<number> {
  return withTransaction(async (client) => {
    for (const input of items) {
      const product: Product = { ...input, id: id('p'), createdAt: now() };
      await run(client, INSERT_PRODUCT, productValues(product, businessId));
    }
    return items.length;
  });
}

export async function updateStock(businessId: string, productId: string, newStock: number): Promise<void> {
  const changes = await run(
    pool,
    'UPDATE products SET "currentStock" = ? WHERE id = ? AND "businessId" = ?',
    [Math.max(0, newStock), productId, businessId],
  );
  if (changes === 0) throw new HttpError('Product not found.', 404);
}

export async function updateProduct(
  businessId: string,
  productId: string,
  fields: Partial<Omit<Product, 'id' | 'createdAt'>>,
): Promise<void> {
  const existing = await one<Product>(pool, 'SELECT * FROM products WHERE id = ? AND "businessId" = ?', [productId, businessId]);
  if (!existing) throw new HttpError('Product not found.', 404);
  const m = { ...existing, ...fields };
  await run(
    pool,
    `UPDATE products SET sku = ?, barcode = ?, name = ?, category = ?, "unitType" = ?, "costPrice" = ?, "retailPrice" = ?, "wholesalePrice" = ?, "currentStock" = ?, "lowStockThreshold" = ?
     WHERE id = ? AND "businessId" = ?`,
    [m.sku, m.barcode ?? null, m.name, m.category, m.unitType, m.costPrice, m.retailPrice, m.wholesalePrice, Math.max(0, m.currentStock), m.lowStockThreshold, productId, businessId],
  );
}

export async function deleteProduct(businessId: string, productId: string): Promise<void> {
  const changes = await run(pool, 'DELETE FROM products WHERE id = ? AND "businessId" = ?', [productId, businessId]);
  if (changes === 0) throw new HttpError('Product not found.', 404);
}

export async function createCustomer(
  businessId: string,
  input: Omit<Customer, 'id' | 'createdAt' | 'balance'>,
): Promise<Customer> {
  const customer: Customer = { ...input, id: id('c'), balance: 0, createdAt: now() };
  await run(
    pool,
    `INSERT INTO customers (id, "businessId", name, mobile, "businessName", "gstIn", "customerType", balance, "createdAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [customer.id, businessId, customer.name, customer.mobile, customer.businessName ?? null, customer.gstIn ?? null, customer.customerType, customer.balance, customer.createdAt],
  );
  return customer;
}

export async function updateCustomer(
  businessId: string,
  customerId: string,
  fields: Partial<Omit<Customer, 'id' | 'createdAt' | 'balance'>>,
): Promise<void> {
  const existing = await one<Customer>(pool, 'SELECT * FROM customers WHERE id = ? AND "businessId" = ?', [customerId, businessId]);
  if (!existing) throw new HttpError('Customer not found.', 404);
  const m = { ...existing, ...fields };
  await run(
    pool,
    'UPDATE customers SET name = ?, mobile = ?, "businessName" = ?, "gstIn" = ?, "customerType" = ? WHERE id = ? AND "businessId" = ?',
    [m.name, m.mobile, m.businessName ?? null, m.gstIn ?? null, m.customerType, customerId, businessId],
  );
}

export async function deleteCustomer(businessId: string, customerId: string): Promise<void> {
  return withTransaction(async (client) => {
    const c = await one<Customer>(client, 'SELECT * FROM customers WHERE id = ? AND "businessId" = ?', [customerId, businessId]);
    if (!c) throw new HttpError('Customer not found.', 404);
    if (c.balance > 0) throw new HttpError('Cannot delete a customer with an outstanding balance. Collect dues first.', 400);
    await run(client, `UPDATE reminders SET status = 'CANCELLED' WHERE "customerId" = ? AND "businessId" = ? AND status = 'QUEUED'`, [customerId, businessId]);
    await run(client, 'DELETE FROM customers WHERE id = ? AND "businessId" = ?', [customerId, businessId]);
  });
}

// ---------------------------------------------------------------------------
// Invoice creation (pricing, stock, ledger, reminders) — atomic
// ---------------------------------------------------------------------------

export interface CreateInvoiceInput {
  customerId: string;
  paymentStatus: 'PAID' | 'CREDIT';
  ptpDate?: string;
  discount?: number;
  taxRate?: number;
  items: { productId: string; quantity: number }[];
}

const INSERT_TXN =
  `INSERT INTO transactions (id, "businessId", "customerId", "customerName", "invoiceId", "invoiceNumber", amount, type, description, "createdAt")
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

interface TxnRow {
  id: string;
  businessId: string;
  customerId: string;
  customerName: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  amount: number;
  type: 'DEBIT' | 'CREDIT';
  description: string;
  createdAt: string;
}

const txnValues = (t: TxnRow): unknown[] => [
  t.id, t.businessId, t.customerId, t.customerName, t.invoiceId, t.invoiceNumber, t.amount, t.type, t.description, t.createdAt,
];

const INSERT_INVOICE =
  `INSERT INTO invoices (id, "businessId", "invoiceNumber", "customerId", "customerName", "customerMobile", subtotal, discount, tax, "taxRate", "grandTotal", "paymentStatus", "ptpDate", "createdAt", items)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_REMINDER =
  `INSERT INTO reminders (id, "businessId", "invoiceId", "customerId", "customerName", "customerMobile", "invoiceAmount", "ptpDate", "triggerType", "scheduledFor", status, "razorpayPaymentLink", "sentAt")
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export async function createInvoice(businessId: string, input: CreateInvoiceInput): Promise<Invoice> {
  return withTransaction(async (client) => {
    const customer = await one<Customer>(client, 'SELECT * FROM customers WHERE id = ? AND "businessId" = ?', [input.customerId, businessId]);
    if (!customer) throw new HttpError('Customer not found.', 404);
    if (!input.items?.length) throw new HttpError('At least one item is required.', 400);
    if (input.paymentStatus === 'CREDIT' && !input.ptpDate) {
      throw new HttpError('A Promise-To-Pay (PTP) date is required for credit invoices.', 400);
    }

    const discount = Math.max(0, input.discount ?? 0);
    const taxRate = Math.min(100, Math.max(0, input.taxRate ?? 18));

    const items: InvoiceItem[] = [];
    for (const { productId, quantity } of input.items) {
      const product = await one<Product>(client, 'SELECT * FROM products WHERE id = ? AND "businessId" = ?', [productId, businessId]);
      if (!product) throw new HttpError(`Product ${productId} not found.`, 404);
      if (quantity <= 0) throw new HttpError(`Invalid quantity for ${product.name}.`, 400);
      if (quantity > product.currentStock) {
        throw new HttpError(`Insufficient stock for ${product.name} (have ${product.currentStock}).`, 400);
      }
      const price = customer.customerType === 'WHOLESALER' ? product.wholesalePrice : product.retailPrice;
      items.push({ id: id('ii'), productId, name: product.name, sku: product.sku, quantity, price, total: price * quantity });
    }

    const subtotal = items.reduce((sum, it) => sum + it.total, 0);
    const tax = Math.max(0, Number(((subtotal - discount) * (taxRate / 100)).toFixed(2)));
    const grandTotal = Math.max(0, Number((subtotal - discount + tax).toFixed(2)));
    const createdAt = now();

    const invoice: Invoice = {
      id: id('inv'),
      invoiceNumber: `CF-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
      customerId: customer.id,
      customerName: customer.name,
      customerMobile: customer.mobile,
      subtotal,
      discount,
      tax,
      taxRate,
      grandTotal,
      paymentStatus: input.paymentStatus,
      ptpDate: input.paymentStatus === 'CREDIT' ? input.ptpDate : undefined,
      createdAt,
      items,
    };

    await run(client, INSERT_INVOICE, [
      invoice.id, businessId, invoice.invoiceNumber, invoice.customerId, invoice.customerName, invoice.customerMobile,
      invoice.subtotal, invoice.discount, invoice.tax, invoice.taxRate, invoice.grandTotal, invoice.paymentStatus, invoice.ptpDate ?? null,
      invoice.createdAt, JSON.stringify(items),
    ]);

    for (const it of items) {
      await run(client, 'UPDATE products SET "currentStock" = "currentStock" - ? WHERE id = ? AND "businessId" = ?', [it.quantity, it.productId, businessId]);
    }

    if (input.paymentStatus === 'CREDIT') {
      await run(client, 'UPDATE customers SET balance = balance + ? WHERE id = ? AND "businessId" = ?', [grandTotal, customer.id, businessId]);
      await run(client, INSERT_TXN, txnValues({
        id: id('t'), businessId, customerId: customer.id, customerName: customer.name, invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber, amount: grandTotal, type: 'DEBIT',
        description: `Credit purchase for Invoice #${invoice.invoiceNumber}`, createdAt,
      }));
      for (const reminder of buildReminderSchedule(invoice)) {
        await run(client, INSERT_REMINDER, [
          reminder.id, businessId, reminder.invoiceId, reminder.customerId, reminder.customerName, reminder.customerMobile,
          reminder.invoiceAmount, reminder.ptpDate, reminder.triggerType, reminder.scheduledFor, reminder.status,
          reminder.razorpayPaymentLink, reminder.sentAt ?? null,
        ]);
      }
    } else {
      await run(client, INSERT_TXN, txnValues({
        id: id('t-d'), businessId, customerId: customer.id, customerName: customer.name, invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber, amount: grandTotal, type: 'DEBIT',
        description: `Purchase for Invoice #${invoice.invoiceNumber}`, createdAt,
      }));
      await run(client, INSERT_TXN, txnValues({
        id: id('t-c'), businessId, customerId: customer.id, customerName: customer.name, invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber, amount: grandTotal, type: 'CREDIT',
        description: `Cash paid for Invoice #${invoice.invoiceNumber}`, createdAt,
      }));
    }

    return invoice;
  });
}

// ---------------------------------------------------------------------------
// Payments & reconciliation
// ---------------------------------------------------------------------------

export async function collectPayment(businessId: string, customerId: string, amount: number, note: string): Promise<void> {
  return withTransaction(async (client) => {
    const customer = await one<Customer>(client, 'SELECT * FROM customers WHERE id = ? AND "businessId" = ?', [customerId, businessId]);
    if (!customer) throw new HttpError('Customer not found.', 404);
    if (amount <= 0) throw new HttpError('Payment amount must be greater than zero.', 400);

    const createdAt = now();
    await run(client, 'UPDATE customers SET balance = ? WHERE id = ? AND "businessId" = ?', [Math.max(0, customer.balance - amount), customerId, businessId]);
    await run(client, INSERT_TXN, txnValues({
      id: id('t-m'), businessId, customerId, customerName: customer.name, invoiceId: null, invoiceNumber: null,
      amount, type: 'CREDIT', description: `Cash received: ${note}`, createdAt,
    }));

    const credits = await many<{ id: string; grandTotal: number }>(
      client,
      `SELECT id, "grandTotal" FROM invoices WHERE "businessId" = ? AND "customerId" = ? AND "paymentStatus" = 'CREDIT' ORDER BY "createdAt" ASC`,
      [businessId, customerId],
    );
    let remaining = amount;
    for (const inv of credits) {
      if (remaining < inv.grandTotal) break;
      remaining -= inv.grandTotal;
      await run(client, `UPDATE invoices SET "paymentStatus" = 'PAID' WHERE id = ?`, [inv.id]);
      await run(client, `UPDATE reminders SET status = 'CANCELLED' WHERE "invoiceId" = ? AND status = 'QUEUED'`, [inv.id]);
    }
  });
}

export async function reconcileInvoice(businessId: string, invoiceId: string): Promise<void> {
  return withTransaction(async (client) => {
    const invoice = await one<{ id: string; customerId: string; customerName: string; invoiceNumber: string; grandTotal: number; paymentStatus: string }>(
      client,
      'SELECT id, "customerId", "customerName", "invoiceNumber", "grandTotal", "paymentStatus" FROM invoices WHERE id = ? AND "businessId" = ?',
      [invoiceId, businessId],
    );
    if (!invoice) throw new HttpError('Invoice not found.', 404);
    if (invoice.paymentStatus === 'PAID') return;

    const createdAt = now();
    await run(client, `UPDATE invoices SET "paymentStatus" = 'PAID' WHERE id = ?`, [invoiceId]);
    await run(client, 'UPDATE customers SET balance = GREATEST(0, balance - ?) WHERE id = ? AND "businessId" = ?', [invoice.grandTotal, invoice.customerId, businessId]);
    await run(client, `UPDATE reminders SET status = 'CANCELLED' WHERE "invoiceId" = ? AND status = 'QUEUED'`, [invoiceId]);
    await run(client, INSERT_TXN, txnValues({
      id: id('t-rzp'), businessId, customerId: invoice.customerId, customerName: invoice.customerName, invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber, amount: invoice.grandTotal, type: 'CREDIT',
      description: `Razorpay Auto-Reconciliation for ${invoice.invoiceNumber}`, createdAt,
    }));
  });
}

/** Recomputes a customer's balance from their transaction ledger. */
async function recomputeBalance(ex: Executor, businessId: string, customerId: string): Promise<void> {
  const row = await one<{ debit: number; credit: number }>(
    ex,
    `SELECT COALESCE(SUM(CASE WHEN type = 'DEBIT' THEN amount ELSE 0 END), 0) AS debit,
            COALESCE(SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE 0 END), 0) AS credit
     FROM transactions WHERE "businessId" = ? AND "customerId" = ?`,
    [businessId, customerId],
  );
  await run(ex, 'UPDATE customers SET balance = ? WHERE id = ? AND "businessId" = ?', [
    Math.max(0, (row?.debit ?? 0) - (row?.credit ?? 0)),
    customerId,
    businessId,
  ]);
}

/** Voids an invoice: restores stock, removes its ledger + reminders, recomputes balance. */
export async function deleteInvoice(businessId: string, invoiceId: string): Promise<void> {
  return withTransaction(async (client) => {
    const inv = await one<{ customerId: string; items: string }>(
      client,
      'SELECT "customerId", items FROM invoices WHERE id = ? AND "businessId" = ?',
      [invoiceId, businessId],
    );
    if (!inv) throw new HttpError('Invoice not found.', 404);

    const items = JSON.parse(inv.items) as InvoiceItem[];
    for (const it of items) {
      await run(client, 'UPDATE products SET "currentStock" = "currentStock" + ? WHERE id = ? AND "businessId" = ?', [it.quantity, it.productId, businessId]);
    }
    await run(client, 'DELETE FROM transactions WHERE "invoiceId" = ? AND "businessId" = ?', [invoiceId, businessId]);
    await run(client, 'DELETE FROM reminders WHERE "invoiceId" = ? AND "businessId" = ?', [invoiceId, businessId]);
    await run(client, 'DELETE FROM invoices WHERE id = ? AND "businessId" = ?', [invoiceId, businessId]);
    await recomputeBalance(client, businessId, inv.customerId);
  });
}

export async function fireReminder(businessId: string, reminderId: string): Promise<{ log: string }> {
  const reminder = await one<WhatsAppReminder>(pool, 'SELECT * FROM reminders WHERE id = ? AND "businessId" = ?', [reminderId, businessId]);
  if (!reminder) throw new HttpError('Reminder not found.', 404);

  const store = await findBusinessById(businessId);
  if (store) await assertReminderQuota(store.accountId);

  const result = simulateSend({
    customerName: reminder.customerName,
    customerMobile: reminder.customerMobile,
    triggerType: reminder.triggerType,
  });
  await run(pool, `UPDATE reminders SET status = 'SENT', "sentAt" = ? WHERE id = ?`, [result.sentAt, reminderId]);
  return { log: result.log };
}

export async function clearAllData(businessId: string): Promise<void> {
  return withTransaction(async (client) => {
    for (const table of ['reminders', 'transactions', 'invoices', 'customers', 'products']) {
      await run(client, `DELETE FROM ${table} WHERE "businessId" = ?`, [businessId]);
    }
  });
}
