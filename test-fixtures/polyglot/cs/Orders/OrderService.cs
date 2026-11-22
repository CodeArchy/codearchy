using System;
using Acme.Billing;

namespace Acme.Orders;

public class OrderService
{
    public Invoice Bill() { return new Invoice(); }
}
