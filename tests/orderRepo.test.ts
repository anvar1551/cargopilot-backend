import { mapCreateOrderDtoToRepoPayload } from "../src/services/orders/orderCreate.mapper";

describe("mapCreateOrderDtoToRepoPayload", () => {
  it("maps a basic order payload without address-book lookups", async () => {
    const payload = await mapCreateOrderDtoToRepoPayload({
      customerEntityId: null,
      sender: { name: "Alice", phone: "+49111" },
      receiver: { name: "Bob", phone: "+49222" },
      addresses: {
        senderAddressId: null,
        receiverAddressId: null,
        pickupAddress: "Hamburg Warehouse Street 1",
        dropoffAddress: "Berlin Delivery Street 2",
        destinationCity: "Berlin",
        senderAddress: { latitude: 41.2995, longitude: 69.2401 },
        receiverAddress: { latitude: 41.3111, longitude: 69.2797 },
        savePickupToAddressBook: false,
        saveDropoffToAddressBook: false,
      },
      shipment: {
        serviceType: "DOOR_TO_DOOR",
        weightKg: 2.5,
        codEnabled: false,
        codAmount: 50,
        currency: "EUR",
      },
      payment: null,
      schedule: null,
      reference: null,
      amount: 19.99,
    });

    expect(payload.pickupAddress).toBe("Hamburg Warehouse Street 1");
    expect(payload.dropoffAddress).toBe("Berlin Delivery Street 2");
    expect(payload.destinationCity).toBe("Berlin");
    expect(payload.pickupLat).toBe(41.2995);
    expect(payload.pickupLng).toBe(69.2401);
    expect(payload.dropoffLat).toBe(41.3111);
    expect(payload.dropoffLng).toBe(69.2797);
    expect(payload.senderName).toBe("Alice");
    expect(payload.receiverName).toBe("Bob");
    expect(payload.codAmount).toBeNull();
    expect(payload.currency).toBeNull();
    expect(payload.amount).toBe(19.99);
  });
});
