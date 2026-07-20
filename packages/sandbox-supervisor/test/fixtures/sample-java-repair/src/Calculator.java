public final class Calculator {
    private Calculator() {}

    public static int add(int left, int right) {
        return left - right;
    }

    public static int subtract(int left, int right) {
        return left + right; // BUG: subtract
    }

    public static int multiply(int left, int right) {
        return left + right; // BUG: multiply
    }

    public static int divide(int left, int right) {
        return left * right; // BUG: divide
    }

    public static int maximum(int left, int right) {
        return left < right ? left : right;
    }

    public static int clamp(int value, int minimum, int maximum) {
        return value; // BUG: clamp
    }

    public static boolean isEven(int value) {
        return value % 2 != 0;
    }

    public static double average(int left, int right) {
        return left + right; // BUG: average
    }

    public static int factorial(int value) {
        return value; // BUG: factorial
    }

    public static int square(int value) {
        return value + value; // BUG: square
    }
}
