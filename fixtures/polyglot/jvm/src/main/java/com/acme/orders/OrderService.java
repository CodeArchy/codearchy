package com.acme.orders;

import com.acme.payments.PaymentClient;
import com.acme.util.*;

public class OrderService {
    private final PaymentClient client = new PaymentClient();
    private final OrderRepo repo = new OrderRepo();
    public boolean place(String id) { return Strings.isBlank(id); }
}
