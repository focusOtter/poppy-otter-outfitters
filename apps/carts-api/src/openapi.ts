import { CATEGORIES } from './catalog.js';
import { SCOPES } from './auth.js';
import { MAX_QUANTITY } from './storage/index.js';

// The OpenAPI 3.1 document agents read to learn the API. The storefront lists it in `/.well-known/poppy.json` under
// `apis`, and `auth0 poppy setup --api-url` and doctor check D7 expect it.

const error = { $ref: '#/components/schemas/Error' };
const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: error } } });
const poppySecurity = [{ poppySession: [] }, { poppySession: [], bearer: [] }];

export function openApiDocument(publicUrl: string, categories = [...CATEGORIES]) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Otter Outfitters Carts API',
      version: '0.1.0',
      description:
        'Cart and checkout for Otter Outfitters outdoor gear. Agents call it with a Poppy-Session header. Browse and cart work as a guest; orders need the user to sign the agent in. Read GET /agent-policy for the rules.',
    },
    servers: [{ url: publicUrl }],
    components: {
      securitySchemes: {
        poppySession: {
          type: 'apiKey',
          in: 'header',
          name: 'Poppy-Session',
          description: 'A Session JWT signed with the key Auth0 delegated to the agent. Sign htm and htu for each request. Send Poppy-Version: 1.0 with it.',
        },
        bearer: { type: 'http', scheme: 'bearer', description: 'An Auth0 access token for this API (DPoP-bound for agents).' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' }, error_description: { type: 'string' } },
        },
        Product: {
          type: 'object',
          required: ['id', 'name', 'priceCents', 'images', 'description', 'category', 'weightGrams'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            priceCents: { type: 'integer', description: 'USD cents.' },
            images: { type: 'array', items: { type: 'string' }, description: 'Paths on the storefront origin.' },
            description: { type: 'string' },
            category: { type: 'string', enum: categories },
            weightGrams: { type: 'integer' },
          },
        },
        CartLine: {
          type: 'object',
          properties: {
            productId: { type: 'string' },
            quantity: { type: 'integer' },
            name: { type: 'string' },
            priceCents: { type: 'integer' },
            lineTotalCents: { type: 'integer' },
          },
        },
        Cart: {
          type: 'object',
          properties: {
            cartKey: { type: 'string' },
            items: { type: 'array', items: { $ref: '#/components/schemas/CartLine' } },
            totalCents: { type: 'integer' },
          },
        },
        Order: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            items: { type: 'array', items: { $ref: '#/components/schemas/CartLine' } },
            totalCents: { type: 'integer' },
            placedVia: { type: ['string', 'null'], description: 'The client metadata URL of the agent that placed it.' },
          },
        },
      },
    },
    paths: {
      '/products': {
        get: {
          operationId: 'listProducts',
          summary: 'List products',
          parameters: [{ name: 'category', in: 'query', required: false, schema: { type: 'string', enum: categories } }],
          responses: {
            200: {
              description: 'The catalog.',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { products: { type: 'array', items: { $ref: '#/components/schemas/Product' } } } },
                },
              },
            },
          },
        },
      },
      '/products/{id}': {
        get: {
          operationId: 'getProduct',
          summary: 'Get one product',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'The product.',
              content: { 'application/json': { schema: { type: 'object', properties: { product: { $ref: '#/components/schemas/Product' } } } } },
            },
            404: errorResponse('No product with that id.'),
          },
        },
      },
      '/cart': {
        get: {
          operationId: 'getCart',
          summary: 'Read the cart',
          description:
            'Works as a guest. The cart follows the agent Session into the account when the User signs it in. Signed in, the agent needs cart:write.',
          'x-poppy-scope': SCOPES.cartWrite,
          security: poppySecurity,
          responses: {
            200: { description: 'The cart.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Cart' } } } },
            400: errorResponse('invalid_session or session_ended.'),
            403: errorResponse('insufficient_scope: a signed-in agent without cart:write.'),
            429: errorResponse('rate_limited. Wait Retry-After seconds.'),
          },
        },
      },
      '/cart/items': {
        post: {
          operationId: 'setCartItem',
          summary: 'Set the quantity of a product in the cart',
          description: 'Sets (not adds) the quantity, so a retried request is safe. Quantity 0 removes the line. Signed in, the agent needs cart:write.',
          'x-poppy-scope': SCOPES.cartWrite,
          security: poppySecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['productId', 'quantity'],
                  properties: { productId: { type: 'string' }, quantity: { type: 'integer', minimum: 0, maximum: MAX_QUANTITY } },
                },
              },
            },
          },
          responses: {
            200: { description: 'The cart.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Cart' } } } },
            400: errorResponse('Unknown product, bad quantity, or an invalid Session.'),
          },
        },
      },
      '/cart/items/{productId}': {
        delete: {
          operationId: 'removeCartItem',
          summary: 'Remove a product from the cart',
          security: poppySecurity,
          parameters: [{ name: 'productId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'The cart.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Cart' } } } } },
        },
      },
      '/orders': {
        get: {
          operationId: 'listOrders',
          summary: 'List the account orders',
          security: poppySecurity,
          'x-poppy-scope': SCOPES.ordersRead,
          responses: {
            200: {
              description: 'The orders.',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { orders: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } },
                },
              },
            },
            401: errorResponse(`Signed out. WWW-Authenticate names scope ${SCOPES.ordersRead}: sign the User in with it.`),
            403: errorResponse('insufficient_scope: a signed-in agent without orders:read.'),
          },
        },
        post: {
          operationId: 'placeOrder',
          summary: 'Check out the cart',
          description:
            'Needs the User to sign the agent in. As a guest the API answers 401 with the scope to ask for. Checkout asks for no address and no saved card: the order ships to a sample address and the payment is simulated, so no money moves. The body is optional; send {"payment":{"card":"4000 0000 0000 0002"}} to see a declined card.',
          security: poppySecurity,
          'x-poppy-scope': SCOPES.ordersWrite,
          requestBody: {
            required: false,
            content: { 'application/json': { schema: { type: 'object', properties: { payment: { type: 'object', properties: { card: { type: 'string', description: 'A test card number. Defaults to 4242 4242 4242 4242 (approved).' } } } } } } },
          },
          responses: {
            402: errorResponse('card_declined or invalid_card. The cart is kept.'),
            201: { description: 'The order.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } },
            401: errorResponse(`Signed out. WWW-Authenticate names scope ${SCOPES.ordersWrite}.`),
            403: errorResponse('insufficient_scope, or policy_denied (over the agent order limit).'),
            409: errorResponse('empty_cart.'),
          },
        },
      },
      '/agent-policy': {
        get: { operationId: 'getAgentPolicy', summary: 'What agents may do here', responses: { 200: { description: 'The policy.' } } },
      },
    },
  };
}
