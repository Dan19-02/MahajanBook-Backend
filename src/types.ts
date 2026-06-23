export type UserRole = 'OWNER' | 'STAFF';

export interface Business {
  id: string;
  name: string;
  joinCode: string;
  address?: string;
  gstIn?: string;
  phone?: string;
  logo?: string;
  upiVpa?: string;
  createdAt: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  businessId: string;
}

export type PaymentStatus = 'PAID' | 'CREDIT';
export type CustomerType = 'RETAILER' | 'WHOLESALER';
export type UnitType = 'Piece' | 'Kg' | 'Liter' | 'Box' | 'Dozen' | 'Meter';

export interface Product {
  id: string;
  sku: string;
  barcode?: string;
  name: string;
  category: string;
  unitType: UnitType;
  costPrice: number;
  retailPrice: number;
  wholesalePrice: number;
  currentStock: number;
  lowStockThreshold: number;
  createdAt: string;
}

export interface Customer {
  id: string;
  name: string;
  mobile: string;
  businessName?: string;
  gstIn?: string;
  customerType: CustomerType;
  balance: number;
  createdAt: string;
}

export interface InvoiceItem {
  id: string;
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  price: number;
  total: number;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerMobile: string;
  subtotal: number;
  discount: number;
  tax: number;
  grandTotal: number;
  paymentStatus: PaymentStatus;
  ptpDate?: string;
  createdAt: string;
  items: InvoiceItem[];
}

export interface Transaction {
  id: string;
  customerId: string;
  customerName: string;
  invoiceId?: string;
  invoiceNumber?: string;
  amount: number;
  type: 'DEBIT' | 'CREDIT';
  description: string;
  createdAt: string;
}

/** Reminder cadence: PTP-1, then every other day (a blank day between each). */
export type ReminderTriggerType =
  | 'PTP_MINUS_1'
  | 'PTP_PLUS_1'
  | 'PTP_PLUS_3'
  | 'PTP_PLUS_5'
  | 'PTP_PLUS_7'
  | 'PTP_PLUS_9'
  | 'PTP_PLUS_11';

export type ReminderStatus = 'QUEUED' | 'SENT' | 'CANCELLED' | 'FAILED';

export interface WhatsAppReminder {
  id: string;
  invoiceId: string;
  customerId: string;
  customerName: string;
  customerMobile: string;
  invoiceAmount: number;
  ptpDate: string;
  triggerType: ReminderTriggerType;
  scheduledFor: string;
  status: ReminderStatus;
  razorpayPaymentLink: string;
  sentAt?: string;
}
