import { db } from './db.js';
import { buildReminderSchedule, simulateSend } from './services/reminders.js';
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
// Businesses (tenants)
// ---------------------------------------------------------------------------

export function createBusiness(name: string): Business {
  // Generate a unique join code.
  let joinCode = code();
  while (db.prepare('SELECT 1 FROM businesses WHERE joinCode = ?').get(joinCode)) joinCode = code();

  const business: Business = { id: id('biz'), name, joinCode, createdAt: now() };
  db.prepare('INSERT INTO businesses (id, name, joinCode, createdAt) VALUES (@id, @name, @joinCode, @createdAt)').run(business);
  return business;
}

export const findBusinessById = (businessId: string): Business | undefined =>
  db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId) as Business | undefined;

export const findBusinessByJoinCode = (joinCode: string): Business | undefined =>
  db.prepare('SELECT * FROM businesses WHERE joinCode = ?').get(joinCode.trim().toUpperCase()) as Business | undefined;

export function updateBusiness(
  businessId: string,
  fields: Partial<Pick<Business, 'name' | 'address' | 'gstIn' | 'phone' | 'logo' | 'upiVpa'>>,
): Business {
  const current = findBusinessById(businessId);
  if (!current) throw new HttpError('Business not found.', 404);
  db.prepare('UPDATE businesses SET name = ?, address = ?, gstIn = ?, phone = ?, logo = ?, upiVpa = ? WHERE id = ?').run(
    fields.name?.trim() || current.name,
    fields.address ?? current.address ?? null,
    (fields.gstIn ?? current.gstIn ?? null) || null,
    fields.phone ?? current.phone ?? null,
    fields.logo ?? current.logo ?? null,
    fields.upiVpa ?? current.upiVpa ?? null,
    businessId,
  );
  return findBusinessById(businessId)!;
}

// ---------------------------------------------------------------------------
// Users (auth)
// ---------------------------------------------------------------------------

interface UserRow extends User {
  passwordHash: string;
  createdAt: string;
}

export function createUser(
  businessId: string,
  name: string,
  email: string,
  passwordHash: string,
  role: UserRole,
): User {
  const user = { id: id('u'), businessId, name, email: email.toLowerCase(), role, createdAt: now() };
  db.prepare(
    `INSERT INTO users (id, businessId, name, email, passwordHash, role, createdAt)
     VALUES (@id, @businessId, @name, @email, @passwordHash, @role, @createdAt)`,
  ).run({ ...user, passwordHash });
  return { id: user.id, businessId, name: user.name, email: user.email, role: user.role };
}

export const findUserByEmail = (email: string): UserRow | undefined =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as UserRow | undefined;

export const findUserById = (userId: string): User | undefined =>
  db.prepare('SELECT id, businessId, name, email, role FROM users WHERE id = ?').get(userId) as User | undefined;

// ---------------------------------------------------------------------------
// Reads (all scoped to a business)
// ---------------------------------------------------------------------------

const mapInvoice = (row: Omit<Invoice, 'items'> & { items: string }): Invoice => ({
  ...row,
  items: JSON.parse(row.items) as InvoiceItem[],
});

export const listProducts = (businessId: string): Product[] =>
  db.prepare('SELECT * FROM products WHERE businessId = ? ORDER BY createdAt DESC').all(businessId) as Product[];

export const listCustomers = (businessId: string): Customer[] =>
  db.prepare('SELECT * FROM customers WHERE businessId = ? ORDER BY createdAt DESC').all(businessId) as Customer[];

export const listInvoices = (businessId: string): Invoice[] =>
  (db.prepare('SELECT * FROM invoices WHERE businessId = ? ORDER BY createdAt DESC').all(businessId) as (Omit<Invoice, 'items'> & { items: string })[])
    .map(mapInvoice);

export const listTransactions = (businessId: string): Transaction[] =>
  db.prepare('SELECT * FROM transactions WHERE businessId = ? ORDER BY createdAt DESC').all(businessId) as Transaction[];

export const listReminders = (businessId: string): WhatsAppReminder[] =>
  db.prepare('SELECT * FROM reminders WHERE businessId = ? ORDER BY scheduledFor ASC').all(businessId) as WhatsAppReminder[];

export interface Snapshot {
  products: Product[];
  customers: Customer[];
  invoices: Invoice[];
  transactions: Transaction[];
  reminders: WhatsAppReminder[];
}

export const snapshot = (businessId: string): Snapshot => ({
  products: listProducts(businessId),
  customers: listCustomers(businessId),
  invoices: listInvoices(businessId),
  transactions: listTransactions(businessId),
  reminders: listReminders(businessId),
});

// ---------------------------------------------------------------------------
// Inventory & customers
// ---------------------------------------------------------------------------

const insertProduct = db.prepare(
  `INSERT INTO products (id, businessId, sku, barcode, name, category, unitType, costPrice, retailPrice, wholesalePrice, currentStock, lowStockThreshold, createdAt)
   VALUES (@id, @businessId, @sku, @barcode, @name, @category, @unitType, @costPrice, @retailPrice, @wholesalePrice, @currentStock, @lowStockThreshold, @createdAt)`,
);

export function createProduct(businessId: string, input: Omit<Product, 'id' | 'createdAt'>): Product {
  const product: Product = { ...input, id: id('p'), createdAt: now() };
  insertProduct.run({ ...product, businessId, barcode: product.barcode ?? null });
  return product;
}

/** Bulk-create products (CSV import / starter catalog). Returns the count added. */
export const createProductsBulk = db.transaction((businessId: string, items: Omit<Product, 'id' | 'createdAt'>[]): number => {
  for (const input of items) {
    insertProduct.run({ ...input, id: id('p'), createdAt: now(), businessId, barcode: input.barcode ?? null });
  }
  return items.length;
}) as (businessId: string, items: Omit<Product, 'id' | 'createdAt'>[]) => number;

export function updateStock(businessId: string, productId: string, newStock: number): void {
  const result = db
    .prepare('UPDATE products SET currentStock = ? WHERE id = ? AND businessId = ?')
    .run(Math.max(0, newStock), productId, businessId);
  if (result.changes === 0) throw new HttpError('Product not found.', 404);
}

export function updateProduct(businessId: string, productId: string, fields: Partial<Omit<Product, 'id' | 'createdAt'>>): void {
  const existing = db.prepare('SELECT * FROM products WHERE id = ? AND businessId = ?').get(productId, businessId) as Product | undefined;
  if (!existing) throw new HttpError('Product not found.', 404);
  const m = { ...existing, ...fields };
  db.prepare(
    `UPDATE products SET sku = ?, barcode = ?, name = ?, category = ?, unitType = ?, costPrice = ?, retailPrice = ?, wholesalePrice = ?, currentStock = ?, lowStockThreshold = ?
     WHERE id = ? AND businessId = ?`,
  ).run(m.sku, m.barcode ?? null, m.name, m.category, m.unitType, m.costPrice, m.retailPrice, m.wholesalePrice, Math.max(0, m.currentStock), m.lowStockThreshold, productId, businessId);
}

export function deleteProduct(businessId: string, productId: string): void {
  const result = db.prepare('DELETE FROM products WHERE id = ? AND businessId = ?').run(productId, businessId);
  if (result.changes === 0) throw new HttpError('Product not found.', 404);
}

export function createCustomer(businessId: string, input: Omit<Customer, 'id' | 'createdAt' | 'balance'>): Customer {
  const customer: Customer = { ...input, id: id('c'), balance: 0, createdAt: now() };
  db.prepare(
    `INSERT INTO customers (id, businessId, name, mobile, businessName, gstIn, customerType, balance, createdAt)
     VALUES (@id, @businessId, @name, @mobile, @businessName, @gstIn, @customerType, @balance, @createdAt)`,
  ).run({ ...customer, businessId, businessName: customer.businessName ?? null, gstIn: customer.gstIn ?? null });
  return customer;
}

export function updateCustomer(businessId: string, customerId: string, fields: Partial<Omit<Customer, 'id' | 'createdAt' | 'balance'>>): void {
  const existing = db.prepare('SELECT * FROM customers WHERE id = ? AND businessId = ?').get(customerId, businessId) as Customer | undefined;
  if (!existing) throw new HttpError('Customer not found.', 404);
  const m = { ...existing, ...fields };
  db.prepare(
    'UPDATE customers SET name = ?, mobile = ?, businessName = ?, gstIn = ?, customerType = ? WHERE id = ? AND businessId = ?',
  ).run(m.name, m.mobile, m.businessName ?? null, m.gstIn ?? null, m.customerType, customerId, businessId);
}

export const deleteCustomer = db.transaction((businessId: string, customerId: string): void => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ? AND businessId = ?').get(customerId, businessId) as Customer | undefined;
  if (!c) throw new HttpError('Customer not found.', 404);
  if (c.balance > 0) throw new HttpError('Cannot delete a customer with an outstanding balance. Collect dues first.', 400);
  db.prepare("UPDATE reminders SET status = 'CANCELLED' WHERE customerId = ? AND businessId = ? AND status = 'QUEUED'").run(customerId, businessId);
  db.prepare('DELETE FROM customers WHERE id = ? AND businessId = ?').run(customerId, businessId);
}) as (businessId: string, customerId: string) => void;

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

const insertInvoice = db.prepare(
  `INSERT INTO invoices (id, businessId, invoiceNumber, customerId, customerName, customerMobile, subtotal, discount, tax, grandTotal, paymentStatus, ptpDate, createdAt, items)
   VALUES (@id, @businessId, @invoiceNumber, @customerId, @customerName, @customerMobile, @subtotal, @discount, @tax, @grandTotal, @paymentStatus, @ptpDate, @createdAt, @items)`,
);
const insertTxn = db.prepare(
  `INSERT INTO transactions (id, businessId, customerId, customerName, invoiceId, invoiceNumber, amount, type, description, createdAt)
   VALUES (@id, @businessId, @customerId, @customerName, @invoiceId, @invoiceNumber, @amount, @type, @description, @createdAt)`,
);
const insertReminder = db.prepare(
  `INSERT INTO reminders (id, businessId, invoiceId, customerId, customerName, customerMobile, invoiceAmount, ptpDate, triggerType, scheduledFor, status, razorpayPaymentLink, sentAt)
   VALUES (@id, @businessId, @invoiceId, @customerId, @customerName, @customerMobile, @invoiceAmount, @ptpDate, @triggerType, @scheduledFor, @status, @razorpayPaymentLink, @sentAt)`,
);

export const createInvoice = db.transaction((businessId: string, input: CreateInvoiceInput): Invoice => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND businessId = ?').get(input.customerId, businessId) as Customer | undefined;
  if (!customer) throw new HttpError('Customer not found.', 404);
  if (!input.items?.length) throw new HttpError('At least one item is required.', 400);
  if (input.paymentStatus === 'CREDIT' && !input.ptpDate) {
    throw new HttpError('A Promise-To-Pay (PTP) date is required for credit invoices.', 400);
  }

  const discount = Math.max(0, input.discount ?? 0);
  const taxRate = input.taxRate ?? 18;

  const items: InvoiceItem[] = input.items.map(({ productId, quantity }) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND businessId = ?').get(productId, businessId) as Product | undefined;
    if (!product) throw new HttpError(`Product ${productId} not found.`, 404);
    if (quantity <= 0) throw new HttpError(`Invalid quantity for ${product.name}.`, 400);
    if (quantity > product.currentStock) {
      throw new HttpError(`Insufficient stock for ${product.name} (have ${product.currentStock}).`, 400);
    }
    const price = customer.customerType === 'WHOLESALER' ? product.wholesalePrice : product.retailPrice;
    return { id: id('ii'), productId, name: product.name, sku: product.sku, quantity, price, total: price * quantity };
  });

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
    grandTotal,
    paymentStatus: input.paymentStatus,
    ptpDate: input.paymentStatus === 'CREDIT' ? input.ptpDate : undefined,
    createdAt,
    items,
  };

  insertInvoice.run({ ...invoice, businessId, ptpDate: invoice.ptpDate ?? null, items: JSON.stringify(items) });

  for (const it of items) {
    db.prepare('UPDATE products SET currentStock = currentStock - ? WHERE id = ? AND businessId = ?').run(it.quantity, it.productId, businessId);
  }

  if (input.paymentStatus === 'CREDIT') {
    db.prepare('UPDATE customers SET balance = balance + ? WHERE id = ? AND businessId = ?').run(grandTotal, customer.id, businessId);
    insertTxn.run({
      id: id('t'), businessId, customerId: customer.id, customerName: customer.name, invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber, amount: grandTotal, type: 'DEBIT',
      description: `Credit purchase for Invoice #${invoice.invoiceNumber}`, createdAt,
    });
    for (const reminder of buildReminderSchedule(invoice)) {
      insertReminder.run({ ...reminder, businessId, sentAt: reminder.sentAt ?? null });
    }
  } else {
    insertTxn.run({
      id: id('t-d'), businessId, customerId: customer.id, customerName: customer.name, invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber, amount: grandTotal, type: 'DEBIT',
      description: `Purchase for Invoice #${invoice.invoiceNumber}`, createdAt,
    });
    insertTxn.run({
      id: id('t-c'), businessId, customerId: customer.id, customerName: customer.name, invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber, amount: grandTotal, type: 'CREDIT',
      description: `Cash paid for Invoice #${invoice.invoiceNumber}`, createdAt,
    });
  }

  return invoice;
}) as (businessId: string, input: CreateInvoiceInput) => Invoice;

// ---------------------------------------------------------------------------
// Payments & reconciliation
// ---------------------------------------------------------------------------

export const collectPayment = db.transaction((businessId: string, customerId: string, amount: number, note: string): void => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND businessId = ?').get(customerId, businessId) as Customer | undefined;
  if (!customer) throw new HttpError('Customer not found.', 404);
  if (amount <= 0) throw new HttpError('Payment amount must be greater than zero.', 400);

  const createdAt = now();
  db.prepare('UPDATE customers SET balance = ? WHERE id = ? AND businessId = ?').run(Math.max(0, customer.balance - amount), customerId, businessId);
  insertTxn.run({
    id: id('t-m'), businessId, customerId, customerName: customer.name, invoiceId: null, invoiceNumber: null,
    amount, type: 'CREDIT', description: `Cash received: ${note}`, createdAt,
  });

  const credits = db
    .prepare("SELECT * FROM invoices WHERE businessId = ? AND customerId = ? AND paymentStatus = 'CREDIT' ORDER BY createdAt ASC")
    .all(businessId, customerId) as Invoice[];
  let remaining = amount;
  for (const inv of credits) {
    if (remaining < inv.grandTotal) break;
    remaining -= inv.grandTotal;
    db.prepare("UPDATE invoices SET paymentStatus = 'PAID' WHERE id = ?").run(inv.id);
    db.prepare("UPDATE reminders SET status = 'CANCELLED' WHERE invoiceId = ? AND status = 'QUEUED'").run(inv.id);
  }
}) as (businessId: string, customerId: string, amount: number, note: string) => void;

export const reconcileInvoice = db.transaction((businessId: string, invoiceId: string): void => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND businessId = ?').get(invoiceId, businessId) as Invoice | undefined;
  if (!invoice) throw new HttpError('Invoice not found.', 404);
  if (invoice.paymentStatus === 'PAID') return;

  const createdAt = now();
  db.prepare("UPDATE invoices SET paymentStatus = 'PAID' WHERE id = ?").run(invoiceId);
  db.prepare('UPDATE customers SET balance = MAX(0, balance - ?) WHERE id = ? AND businessId = ?').run(invoice.grandTotal, invoice.customerId, businessId);
  db.prepare("UPDATE reminders SET status = 'CANCELLED' WHERE invoiceId = ? AND status = 'QUEUED'").run(invoiceId);
  insertTxn.run({
    id: id('t-rzp'), businessId, customerId: invoice.customerId, customerName: invoice.customerName, invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber, amount: invoice.grandTotal, type: 'CREDIT',
    description: `Razorpay Auto-Reconciliation for ${invoice.invoiceNumber}`, createdAt,
  });
}) as (businessId: string, invoiceId: string) => void;

/** Recomputes a customer's balance from their transaction ledger. */
function recomputeBalance(businessId: string, customerId: string): void {
  const row = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type = 'DEBIT' THEN amount ELSE 0 END), 0) AS debit,
            COALESCE(SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE 0 END), 0) AS credit
     FROM transactions WHERE businessId = ? AND customerId = ?`,
  ).get(businessId, customerId) as { debit: number; credit: number };
  db.prepare('UPDATE customers SET balance = ? WHERE id = ? AND businessId = ?').run(
    Math.max(0, row.debit - row.credit),
    customerId,
    businessId,
  );
}

/** Voids an invoice: restores stock, removes its ledger + reminders, recomputes balance. */
export const deleteInvoice = db.transaction((businessId: string, invoiceId: string): void => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND businessId = ?').get(invoiceId, businessId) as
    | (Omit<Invoice, 'items'> & { items: string })
    | undefined;
  if (!inv) throw new HttpError('Invoice not found.', 404);

  const items = JSON.parse(inv.items) as InvoiceItem[];
  for (const it of items) {
    db.prepare('UPDATE products SET currentStock = currentStock + ? WHERE id = ? AND businessId = ?').run(it.quantity, it.productId, businessId);
  }
  db.prepare('DELETE FROM transactions WHERE invoiceId = ? AND businessId = ?').run(invoiceId, businessId);
  db.prepare('DELETE FROM reminders WHERE invoiceId = ? AND businessId = ?').run(invoiceId, businessId);
  db.prepare('DELETE FROM invoices WHERE id = ? AND businessId = ?').run(invoiceId, businessId);
  recomputeBalance(businessId, inv.customerId);
}) as (businessId: string, invoiceId: string) => void;

export function fireReminder(businessId: string, reminderId: string): { log: string } {
  const reminder = db.prepare('SELECT * FROM reminders WHERE id = ? AND businessId = ?').get(reminderId, businessId) as WhatsAppReminder | undefined;
  if (!reminder) throw new HttpError('Reminder not found.', 404);

  const result = simulateSend({
    customerName: reminder.customerName,
    customerMobile: reminder.customerMobile,
    triggerType: reminder.triggerType,
  });
  db.prepare("UPDATE reminders SET status = 'SENT', sentAt = ? WHERE id = ?").run(result.sentAt, reminderId);
  return { log: result.log };
}

export const clearAllData = db.transaction((businessId: string): void => {
  for (const table of ['reminders', 'transactions', 'invoices', 'customers', 'products']) {
    db.prepare(`DELETE FROM ${table} WHERE businessId = ?`).run(businessId);
  }
}) as (businessId: string) => void;
