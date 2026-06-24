import { Router, type Response } from 'express';
import {
  HttpError,
  snapshot,
  createProduct,
  createProductsBulk,
  updateStock,
  updateProduct,
  deleteProduct,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  createInvoice,
  deleteInvoice,
  collectPayment,
  reconcileInvoice,
  fireReminder,
  clearAllData,
  updateBusiness,
  type CreateInvoiceInput,
} from '../store.js';
import type { AuthedRequest } from '../middleware/auth.js';
import type { CustomerType, UnitType, Product, Customer } from '../types.js';

const router = Router();

type Handler = (req: AuthedRequest, res: Response) => Promise<void>;

/** Wraps an async handler, injects the caller's businessId, and maps HttpError → status. */
const guard =
  (fn: (req: AuthedRequest, res: Response, businessId: string) => Promise<void>): Handler =>
  async (req, res) => {
    const businessId = req.user?.businessId;
    if (!businessId) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    try {
      await fn(req, res, businessId);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[data route] error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Initial data load
router.get('/bootstrap', guard(async (_req, res, businessId) => {
  res.json(await snapshot(businessId));
}));

// Update the shop profile (owner only) — name, address, GSTIN, phone, logo
router.patch('/business', guard(async (req, res, businessId) => {
  if (req.user?.role !== 'OWNER') throw new HttpError('Only the owner can update the business profile.', 403);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const business = await updateBusiness(businessId, {
    ...(b.name !== undefined ? { name: str(b.name) } : {}),
    ...(b.address !== undefined ? { address: str(b.address) } : {}),
    ...(b.gstIn !== undefined ? { gstIn: str(b.gstIn).toUpperCase() } : {}),
    ...(b.phone !== undefined ? { phone: str(b.phone) } : {}),
    ...(b.logo !== undefined ? { logo: typeof b.logo === 'string' && (b.logo === '' || b.logo.startsWith('data:image/')) ? b.logo : '' } : {}),
    ...(b.upiVpa !== undefined ? { upiVpa: str(b.upiVpa) } : {}),
  });
  res.json({ business });
}));

// Inventory
router.post('/products', guard(async (req, res, businessId) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (!str(b.name) || !str(b.sku)) throw new HttpError('Product name and SKU are required.', 400);
  await createProduct(businessId, {
    sku: str(b.sku).toUpperCase(),
    barcode: str(b.barcode) || undefined,
    name: str(b.name),
    category: str(b.category) || 'Groceries',
    unitType: (str(b.unitType) || 'Piece') as UnitType,
    costPrice: num(b.costPrice),
    retailPrice: num(b.retailPrice),
    wholesalePrice: num(b.wholesalePrice),
    currentStock: num(b.currentStock),
    lowStockThreshold: num(b.lowStockThreshold),
  });
  res.status(201).json(await snapshot(businessId));
}));

// Bulk create (CSV import / starter catalog)
router.post('/products/bulk', guard(async (req, res, businessId) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const list = Array.isArray(b.products) ? b.products : [];
  if (list.length === 0) throw new HttpError('No products provided.', 400);
  if (list.length > 1000) throw new HttpError('Too many products in one import (max 1000).', 400);
  const items = list.map((raw) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    if (!str(p.name) || !str(p.sku)) throw new HttpError('Every product needs a name and SKU.', 400);
    return {
      sku: str(p.sku).toUpperCase(),
      barcode: str(p.barcode) || undefined,
      name: str(p.name),
      category: str(p.category) || 'Groceries',
      unitType: (str(p.unitType) || 'Piece') as UnitType,
      costPrice: num(p.costPrice),
      retailPrice: num(p.retailPrice),
      wholesalePrice: num(p.wholesalePrice),
      currentStock: num(p.currentStock),
      lowStockThreshold: num(p.lowStockThreshold) || 5,
    };
  });
  await createProductsBulk(businessId, items);
  res.status(201).json(await snapshot(businessId));
}));

router.patch('/products/:id/stock', guard(async (req, res, businessId) => {
  await updateStock(businessId, req.params.id, num((req.body as Record<string, unknown>)?.currentStock));
  res.json(await snapshot(businessId));
}));

router.patch('/products/:id', guard(async (req, res, businessId) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const fields: Partial<Omit<Product, 'id' | 'createdAt'>> = {};
  if (b.sku !== undefined) fields.sku = str(b.sku).toUpperCase();
  if (b.name !== undefined) fields.name = str(b.name);
  if (b.category !== undefined) fields.category = str(b.category) || 'Groceries';
  if (b.unitType !== undefined) fields.unitType = (str(b.unitType) || 'Piece') as UnitType;
  if (b.costPrice !== undefined) fields.costPrice = num(b.costPrice);
  if (b.retailPrice !== undefined) fields.retailPrice = num(b.retailPrice);
  if (b.wholesalePrice !== undefined) fields.wholesalePrice = num(b.wholesalePrice);
  if (b.currentStock !== undefined) fields.currentStock = num(b.currentStock);
  if (b.lowStockThreshold !== undefined) fields.lowStockThreshold = num(b.lowStockThreshold);
  if (b.barcode !== undefined) fields.barcode = str(b.barcode) || undefined;
  await updateProduct(businessId, req.params.id, fields);
  res.json(await snapshot(businessId));
}));

router.delete('/products/:id', guard(async (req, res, businessId) => {
  await deleteProduct(businessId, req.params.id);
  res.json(await snapshot(businessId));
}));

// Customers
router.post('/customers', guard(async (req, res, businessId) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (!str(b.name) || !str(b.mobile)) throw new HttpError('Customer name and mobile are required.', 400);
  const customerType = (str(b.customerType) === 'WHOLESALER' ? 'WHOLESALER' : 'RETAILER') as CustomerType;
  await createCustomer(businessId, {
    name: str(b.name),
    mobile: str(b.mobile),
    businessName: str(b.businessName) || undefined,
    gstIn: str(b.gstIn).toUpperCase() || undefined,
    customerType,
  });
  res.status(201).json(await snapshot(businessId));
}));

router.patch('/customers/:id', guard(async (req, res, businessId) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const fields: Partial<Omit<Customer, 'id' | 'createdAt' | 'balance'>> = {};
  if (b.name !== undefined) fields.name = str(b.name);
  if (b.mobile !== undefined) fields.mobile = str(b.mobile);
  if (b.businessName !== undefined) fields.businessName = str(b.businessName) || undefined;
  if (b.gstIn !== undefined) fields.gstIn = str(b.gstIn).toUpperCase() || undefined;
  if (b.customerType !== undefined) fields.customerType = (str(b.customerType) === 'WHOLESALER' ? 'WHOLESALER' : 'RETAILER') as CustomerType;
  await updateCustomer(businessId, req.params.id, fields);
  res.json(await snapshot(businessId));
}));

router.delete('/customers/:id', guard(async (req, res, businessId) => {
  await deleteCustomer(businessId, req.params.id);
  res.json(await snapshot(businessId));
}));

// Invoices (server computes pricing, stock, ledger, reminders)
router.post('/invoices', guard(async (req, res, businessId) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const items = Array.isArray(b.items)
    ? b.items.map((it) => ({ productId: str((it as Record<string, unknown>).productId), quantity: num((it as Record<string, unknown>).quantity) }))
    : [];
  const input: CreateInvoiceInput = {
    customerId: str(b.customerId),
    paymentStatus: str(b.paymentStatus) === 'CREDIT' ? 'CREDIT' : 'PAID',
    ptpDate: str(b.ptpDate) || undefined,
    discount: num(b.discount),
    items,
  };
  const invoice = await createInvoice(businessId, input);
  res.status(201).json({ invoice, snapshot: await snapshot(businessId) });
}));

// Void an invoice (restores stock, removes ledger entries + reminders)
router.delete('/invoices/:id', guard(async (req, res, businessId) => {
  await deleteInvoice(businessId, req.params.id);
  res.json(await snapshot(businessId));
}));

// Collect a manual cash payment
router.post('/payments', guard(async (req, res, businessId) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  await collectPayment(businessId, str(b.customerId), num(b.amount), str(b.note) || 'Manual payment');
  res.json(await snapshot(businessId));
}));

// Razorpay auto-reconcile
router.post('/invoices/:id/reconcile', guard(async (req, res, businessId) => {
  await reconcileInvoice(businessId, req.params.id);
  res.json(await snapshot(businessId));
}));

// Fire a WhatsApp reminder (delivery handled here on the backend)
router.post('/reminders/:id/send', guard(async (req, res, businessId) => {
  const { log } = await fireReminder(businessId, req.params.id);
  res.json({ log, snapshot: await snapshot(businessId) });
}));

// Wipe this business's data (owner only; keeps user accounts)
router.delete('/data', guard(async (req, res, businessId) => {
  if (req.user?.role !== 'OWNER') throw new HttpError('Only the owner can clear all data.', 403);
  await clearAllData(businessId);
  res.json(await snapshot(businessId));
}));

export default router;
