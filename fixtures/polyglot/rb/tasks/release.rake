require 'billing'

task :release do
  Billing.invoice(0)
end
