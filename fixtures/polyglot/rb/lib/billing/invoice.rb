require_relative 'money'

module Billing
  class Invoice
    attr_reader :total

    def initialize(total)
      @total = Money.new(total)
    end

    def to_s
      format_total
    end

    private

    def format_total
      total.to_s
    end
  end
end
