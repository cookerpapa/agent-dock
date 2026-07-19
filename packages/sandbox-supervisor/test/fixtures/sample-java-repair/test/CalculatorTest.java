public final class CalculatorTest {
    public static void main(String[] args) {
        int actual = Calculator.add(2, 3);
        if (actual != 5) {
            throw new AssertionError("expected 2 + 3 to equal 5, got " + actual);
        }
        System.out.println("CalculatorTest passed");
    }
}
