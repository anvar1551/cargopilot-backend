import * as orderRepo from "../src/services/orders/orderRepo";
import * as db from "../src/config/db";

describe("Order Repository (mocked DB)", () => {
  // mock connection object with fake methods
  const mockConn = {
    prepare: jest.fn().mockReturnThis(),
    exec: jest.fn(),
    drop: jest.fn(),
    disconnect: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(db, "getConnection").mockReturnValue(mockConn as any);
  });

  it("should create a new order and return it", () => {
    const fakeOrder = {
      ID: "abc123",
      CUSTOMER_ID: "cust001",
      PICKUP_ADDRESS: "Hamburg",
      DROPOFF_ADDRESS: "Berlin",
      STATUS: "pending",
    };

    // Simulate first exec = insert (no return)
    // and second exec = select (returns array)
    mockConn.exec
      .mockReturnValueOnce(undefined) // first call (insert)
      .mockReturnValueOnce([fakeOrder]); // second call (select)

    const result = orderRepo.createOrder("cust001", "Hamburg", "Berlin");

    expect(mockConn.prepare).toHaveBeenCalledTimes(1);
    expect(mockConn.exec).toHaveBeenCalledTimes(2);
    expect(result).toEqual(fakeOrder);
  });

  it("should return null if no order found", () => {
    mockConn.prepare.mockReturnThis();
    mockConn.exec.mockReturnValueOnce([]);

    const result = orderRepo.getOrderById("nope");

    expect(result).toBeNull();
  });
});
