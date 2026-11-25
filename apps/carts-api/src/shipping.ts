// The delivery address every order ships to. It is a sample: nothing is shipped, and checkout asks for no address.

export interface ShippingAddress {
  name: string;
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  /** Always true: no parcel is sent. */
  simulated: true;
}

export const SAMPLE_ADDRESS: ShippingAddress = {
  name: 'Drift Bean sample customer',
  line1: '12 Drift Bean Lane',
  city: 'Portland',
  region: 'OR',
  postalCode: '97201',
  country: 'US',
  simulated: true,
};
