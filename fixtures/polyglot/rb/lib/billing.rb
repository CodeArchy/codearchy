require 'json'
require 'billing/invoice'

# Entry point of the billing gem.
module Billing
  def self.invoice(total)
    Invoice.new(total)
  end
end
