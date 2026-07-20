public final class evenTest {
    public static void main(String[] args) {
        if (!Calculator.isEven(8) || Calculator.isEven(7)) throw new AssertionError("even");
        System.out.println("even passed");
    }
}
